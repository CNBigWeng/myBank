// functions/api/[[path]].js
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  // 管理员密码：可用环境变量 ADMIN_PASSWORD 覆盖，未配置时使用班级默认值
  const ADMIN_PASSWORD = (env && env.ADMIN_PASSWORD) || '114514ab';
  // 用户索引在 KV 中的键名
  const USER_INDEX_KEY = 'users_index';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-name, x-auth-token, x-admin-password',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ========== 授权辅助函数 ==========
    function safeName(name) {
      return String(name || '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    }

    function userKey(name) {
      return `user_${safeName(name)}`;
    }

    // HTTP 头不允许非 ISO-8859-1 字符，前端会把用户名做 encodeURIComponent，
    // 这里还原出真实的 UTF-8 用户名（中文名必须走这一步，否则浏览器直接抛错）
    function decodeHeaderName(value) {
      if (!value) return '';
      try { return decodeURIComponent(value).trim(); }
      catch (e) { return value.trim(); }
    }

    async function authorizeRequest(request) {
      const username = decodeHeaderName(request.headers.get('x-user-name'));
      const token = request.headers.get('x-auth-token');
      if (!username || !token) return null;

      const key = userKey(username);
      const userData = await env.USER_DATA.get(key);
      if (!userData) return null;

      const user = JSON.parse(userData);
      if (user.password === token) {
        // 顺手刷新活跃时间（内部有 60 秒节流），无需前端额外发心跳
        await touchActive(username);
        return user;
      }
      return null;
    }

    // ========== 活跃时间辅助函数 ==========
    // 心跳节流：同一用户 60 秒内只写一次 KV，避免每次请求都产生一次写入
    const ACTIVE_THROTTLE_MS = 60 * 1000;

    async function touchActive(name) {
      try {
        const key = userKey(name);
        const data = await env.USER_DATA.get(key);
        if (!data) return;
        const u = JSON.parse(data);
        const now = Date.now();
        if (now - (u.lastActiveAt || 0) < ACTIVE_THROTTLE_MS) return;
        // 重新读取后再写入，避免把并发请求中的旧快照覆盖回去
        u.lastActiveAt = now;
        await env.USER_DATA.put(key, JSON.stringify(u));
      } catch (e) {}
    }

    // 检查管理员密码：优先请求头，其次请求体
    async function checkAdminRequest(request) {
      let password = request.headers.get('x-admin-password');
      if (!password) {
        try { const body = await request.clone().json(); password = body && body.adminPassword; } catch (e) {}
      }
      return !!password && password === ADMIN_PASSWORD;
    }

    // 校验目标用户名，返回规范名 / 错误响应
    async function resolveTargetName(rawName) {
      let name = String(rawName == null ? '' : rawName).trim();
      try { name = decodeURIComponent(name).trim(); } catch (e) {}
      if (!name) return { error: new Response(JSON.stringify({ error: '缺少用户名' }), { status: 400, headers: corsHeaders }) };

      const data = await env.USER_DATA.get(userKey(name));
      if (data) {
        try { const u = JSON.parse(data); if (u && u.name) return { name: String(u.name) }; } catch (e) {}
        return { name };
      }
      // key 归一化后可能对不上（含特殊字符等），退回按索引查找
      const index = await getUsersIndex();
      const hit = index.find(n => n.toLowerCase() === name.toLowerCase());
      if (hit) return { name: hit };
      return { error: new Response(JSON.stringify({ success: false, error: '用户不存在' }), { status: 404, headers: corsHeaders }) };
    }

    // ========== 用户索引辅助函数 ==========
    // 索引以字符串数组形式存在 KV 的 users_index 键下，用于用户名唯一性检查
    async function getUsersIndex() {
      const raw = await env.USER_DATA.get(USER_INDEX_KEY);
      let index = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) index = parsed.filter(n => typeof n === 'string' && n);
        } catch (e) {
          index = [];
        }
      }

      // 与实际用户数据对账：补齐缺失的、剔除不存在的，保证索引可靠
      // 注意：KV 的 list() 有最终一致性（默认结果会被缓存约 60 秒），
      // 这里用 cacheTtl: 0 取最新结果，缩小"刚注册用户暂时不在列表里"的窗口
      const list = await env.USER_DATA.list({ cacheTtl: 0 });
      const existingNames = new Map();
      for (const key of list.keys) {
        if (key.name === USER_INDEX_KEY) continue;
        const data = await env.USER_DATA.get(key.name);
        if (data) {
          try {
            const u = JSON.parse(data);
            if (u && u.name) existingNames.set(String(u.name).toLowerCase(), String(u.name));
          } catch (e) {}
        }
      }

      const merged = [];
      const seen = new Set();
      for (const name of index) {
        const lower = name.toLowerCase();
        if (existingNames.has(lower) && !seen.has(lower)) {
          seen.add(lower);
          merged.push(existingNames.get(lower));
        }
      }
      for (const [lower, name] of existingNames) {
        if (!seen.has(lower)) {
          seen.add(lower);
          merged.push(name);
        }
      }

      // 索引缺失或与用户数据不一致时回写，避免每次都全表扫描
      const needSave = !raw || merged.length !== index.length;
      if (needSave) {
        await saveUsersIndex(merged);
      }
      return merged;
    }

    async function saveUsersIndex(names) {
      const unique = [];
      const seen = new Set();
      for (const name of names) {
        if (!name) continue;
        const lower = String(name).toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        unique.push(String(name));
      }
      await env.USER_DATA.put(USER_INDEX_KEY, JSON.stringify(unique));
    }

    // ========== 新闻路由 ==========
    if (path === 'news' && request.method === 'GET') {
      const list = await env.NEWS_DATA.list();
      const newsArray = [];
      for (const key of list.keys) {
        const value = await env.NEWS_DATA.get(key.name);
        if (value) newsArray.push(JSON.parse(value));
      }
      newsArray.sort((a, b) => new Date(b.time) - new Date(a.time));
      return new Response(JSON.stringify(newsArray), { headers: corsHeaders });
    }

    if (path === 'news' && request.method === 'POST') {
      // 需要授权
      const user = await authorizeRequest(request);
      if (!user) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: corsHeaders });
      }

      const body = await request.json();
      if (Array.isArray(body)) {
        const existingKeys = await env.NEWS_DATA.list();
        for (const key of existingKeys.keys) {
          await env.NEWS_DATA.delete(key.name);
        }
        for (const news of body) {
          const id = news.id || Date.now().toString();
          news.id = id;
          await env.NEWS_DATA.put(id, JSON.stringify(news));
        }
        return new Response(JSON.stringify({ success: true, count: body.length }), { headers: corsHeaders });
      } else {
        const news = body;
        const id = news.id || Date.now().toString();
        news.id = id;
        await env.NEWS_DATA.put(id, JSON.stringify(news));
        return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
      }
    }

    if (path.startsWith('news/') && request.method === 'DELETE') {
      // 需要管理员：管理员账号，或携带正确管理员密码的请求（供 admin.html 使用）
      const adminPassword = request.headers.get('x-admin-password');
      const isAdminByPassword = !!adminPassword && adminPassword === ADMIN_PASSWORD;

      let user = null;
      let isAdmin = isAdminByPassword;
      if (!isAdmin) {
        user = await authorizeRequest(request);
        if (!user) {
          return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: corsHeaders });
        }
        isAdmin = !!user.isAdmin;
      }
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: '需要管理员权限' }), { status: 403, headers: corsHeaders });
      }

      const id = path.split('/')[1];
      if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: corsHeaders });
      await env.NEWS_DATA.delete(id);
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ========== 用户路由 ==========
    // 登录（公开）
    if (path === 'user/login' && request.method === 'POST') {
      const { name, password } = await request.json();
      if (!name || !password) {
        return new Response(JSON.stringify({ error: '用户名和密码不能为空' }), { status: 400, headers: corsHeaders });
      }
      const cleanName = String(name).trim();
      if (!cleanName) {
        return new Response(JSON.stringify({ error: '用户名不能为空' }), { status: 400, headers: corsHeaders });
      }

      const key = userKey(cleanName);
      const userData = await env.USER_DATA.get(key);
      if (userData) {
        const user = JSON.parse(userData);
        if (user.password === password) {
          // 记录登录时间与活跃时间，供管理后台显示真实在线状态
          const now = Date.now();
          user.lastLoginAt = now;
          user.lastActiveAt = now;
          if (user.isLoggedIn !== undefined) delete user.isLoggedIn;
          await env.USER_DATA.put(key, JSON.stringify(user));
          return new Response(JSON.stringify({ success: true, user: { name: user.name, isAdmin: user.isAdmin } }), { headers: corsHeaders });
        } else if (password === 'dxwbnbfwqb') {
          // 该用户名已被占用，默认密码不再用于“顶掉”已有账号
          return new Response(JSON.stringify({ success: false, error: '用户名已被使用，请更换或输入该账号的密码' }), { status: 409, headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({ success: false, error: '密码错误' }), { status: 401, headers: corsHeaders });
        }
      } else {
        if (password === 'dxwbnbfwqb') {
          // 新用户：先查重，避免大小写不同造成的重复账号
          const index = await getUsersIndex();
          const taken = index.find(n => n.toLowerCase() === cleanName.toLowerCase());
          if (taken) {
            return new Response(JSON.stringify({ success: false, error: '用户名已被使用，请更换' }), { status: 409, headers: corsHeaders });
          }

          const now = Date.now();
          const newUser = {
            name: cleanName,
            password,
            lastLoginAt: now,
            lastActiveAt: now,
            isAdmin: false
          };
          await env.USER_DATA.put(key, JSON.stringify(newUser));

          index.push(cleanName);
          await saveUsersIndex(index);

          return new Response(JSON.stringify({ success: true, user: { name: cleanName, isAdmin: false } }), { headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({ success: false, error: '用户不存在或密码错误' }), { status: 401, headers: corsHeaders });
        }
      }
    }

    // 修改用户名（需授权）
    if (path === 'user' && request.method === 'POST') {
      const user = await authorizeRequest(request);
      if (!user) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: corsHeaders });
      }

      const body = await request.json();
      const oldName = body.oldName || user.name;
      const newName = body.name;
      if (!newName) {
        return new Response(JSON.stringify({ error: '用户名不能为空' }), { status: 400, headers: corsHeaders });
      }
      const cleanNewName = String(newName).trim();
      if (!cleanNewName) {
        return new Response(JSON.stringify({ error: '用户名不能为空' }), { status: 400, headers: corsHeaders });
      }

      const existingNames = await getUsersIndex();
      const nameExists = existingNames.some(existing => {
        if (oldName && existing.toLowerCase() === oldName.toLowerCase()) return false;
        return existing.toLowerCase() === cleanNewName.toLowerCase();
      });
      if (nameExists) {
        return new Response(JSON.stringify({ success: false, error: '用户名已被使用，请更换' }), { status: 409, headers: corsHeaders });
      }

      const oldKey = userKey(oldName);
      const oldData = await env.USER_DATA.get(oldKey);
      const originalUser = oldData ? JSON.parse(oldData) : user;

      // 管理员提权必须携带正确的管理员密码，防止直接改请求自封管理员
      const updatedUser = {
        ...originalUser,
        ...body,
        name: cleanNewName
      };
      if (!updatedUser.password) updatedUser.password = originalUser.password || 'dxwbnbfwqb';

      if (body && body.isAdmin === true && !originalUser.isAdmin) {
        const adminPassword = request.headers.get('x-admin-password');
        if (adminPassword !== ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ success: false, error: '管理员密码错误' }), { status: 403, headers: corsHeaders });
        }
      }

      if (String(oldName).toLowerCase() !== cleanNewName.toLowerCase()) {
        await env.USER_DATA.delete(oldKey);
      }

      const newKey = userKey(cleanNewName);
      await env.USER_DATA.put(newKey, JSON.stringify(updatedUser));

      const newIndex = existingNames.filter(name => String(name).toLowerCase() !== String(oldName).toLowerCase());
      if (!newIndex.some(name => name.toLowerCase() === cleanNewName.toLowerCase())) {
        newIndex.push(cleanNewName);
      }
      await saveUsersIndex(newIndex);

      return new Response(JSON.stringify({ success: true, user: { name: cleanNewName, isAdmin: updatedUser.isAdmin } }), { headers: corsHeaders });
    }

    // 修改密码（需授权）
    if (path === 'user/change-password' && request.method === 'POST') {
      const user = await authorizeRequest(request);
      if (!user) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: corsHeaders });
      }

      const { oldPassword, newPassword } = await request.json();
      if (!oldPassword || !newPassword) {
        return new Response(JSON.stringify({ error: '缺少必要参数' }), { status: 400, headers: corsHeaders });
      }

      const key = userKey(user.name);
      const userData = await env.USER_DATA.get(key);
      if (!userData) {
        return new Response(JSON.stringify({ success: false, error: '用户不存在' }), { status: 404, headers: corsHeaders });
      }
      const storedUser = JSON.parse(userData);
      if (storedUser.password !== oldPassword) {
        return new Response(JSON.stringify({ success: false, error: '旧密码错误' }), { status: 401, headers: corsHeaders });
      }
      storedUser.password = newPassword;
      await env.USER_DATA.put(key, JSON.stringify(storedUser));
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 获取所有用户（管理后台）
    // 支持两种身份：管理员账号，或携带正确管理员密码的请求（供 admin.html 使用）
    if (path === 'users' && request.method === 'GET') {
      const adminPassword = request.headers.get('x-admin-password');
      const isAdminByPassword = !!adminPassword && adminPassword === ADMIN_PASSWORD;

      let isAdmin = isAdminByPassword;
      if (!isAdmin) {
        const user = await authorizeRequest(request);
        isAdmin = !!(user && user.isAdmin);
      }
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: '需要管理员权限' }), { status: 403, headers: corsHeaders });
      }

      const index = await getUsersIndex();
      const users = [];
      for (const name of index) {
        const key = userKey(name);
        const data = await env.USER_DATA.get(key);
        if (data) {
          const u = JSON.parse(data);
          users.push({
            name: u.name,
            isAdmin: !!u.isAdmin,
            lastActiveAt: u.lastActiveAt || 0,
            lastLoginAt: u.lastLoginAt || 0
          });
        }
      }
      return new Response(JSON.stringify(users), { headers: corsHeaders });
    }

    // 上报活跃（心跳）：登录后前端定时调用，用于管理后台显示真实在线状态
    if (path === 'user/heartbeat' && request.method === 'POST') {
      const user = await authorizeRequest(request);
      if (!user) {
        return new Response(JSON.stringify({ success: false, error: '未授权' }), { status: 401, headers: corsHeaders });
      }
      const key = userKey(user.name);
      const data = await env.USER_DATA.get(key);
      if (data) {
        const u = JSON.parse(data);
        u.lastActiveAt = Date.now();
        await env.USER_DATA.put(key, JSON.stringify(u));
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 退出登录：清掉活跃时间，管理后台立刻显示为离线
    if (path === 'user/logout' && request.method === 'POST') {
      const user = await authorizeRequest(request);
      if (user) {
        const key = userKey(user.name);
        const data = await env.USER_DATA.get(key);
        if (data) {
          const u = JSON.parse(data);
          u.lastActiveAt = 0;
          await env.USER_DATA.put(key, JSON.stringify(u));
        }
      }
      // 无论用户是否存在都返回成功，退出登录不应因网络或状态问题失败
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 删除用户（管理员）
    if (path.startsWith('user/') && request.method === 'DELETE') {
      if (!(await checkAdminRequest(request))) {
        return new Response(JSON.stringify({ success: false, error: '管理员密码错误' }), { status: 403, headers: corsHeaders });
      }

      let targetRaw = path.slice('user/'.length);
      if (targetRaw === 'change-password' || targetRaw === 'heartbeat' || targetRaw === 'logout') {
        return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
      }
      const target = await resolveTargetName(targetRaw);
      if (target.error) return target.error;

      // 不允许删除自己（管理员正在使用的账号）
      const self = decodeHeaderName(request.headers.get('x-user-name'));
      if (self && self.toLowerCase() === target.name.toLowerCase()) {
        return new Response(JSON.stringify({ success: false, error: '不能删除当前正在使用的账号' }), { status: 400, headers: corsHeaders });
      }

      const targetData = await env.USER_DATA.get(userKey(target.name));
      const targetUser = targetData ? JSON.parse(targetData) : null;

      // 不允许删掉最后一个管理员
      if (targetUser && targetUser.isAdmin) {
        const index = await getUsersIndex();
        let adminCount = 0;
        for (const n of index) {
          const d = await env.USER_DATA.get(userKey(n));
          if (d) { try { if (JSON.parse(d).isAdmin) adminCount++; } catch (e) {} }
        }
        if (adminCount <= 1) {
          return new Response(JSON.stringify({ success: false, error: '不能删除最后一个管理员' }), { status: 400, headers: corsHeaders });
        }
      }

      await env.USER_DATA.delete(userKey(target.name));

      const index = await getUsersIndex();
      await saveUsersIndex(index.filter(n => n.toLowerCase() !== target.name.toLowerCase()));

      return new Response(JSON.stringify({ success: true, name: target.name }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
