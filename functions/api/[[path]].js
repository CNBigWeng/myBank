// functions/api/[[path]].js
export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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
      const id = path.split('/')[1];
      if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: corsHeaders });
      await env.NEWS_DATA.delete(id);
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ========== 用户路由 ==========
    // 辅助函数：获取用户列表索引
    async function getUsersIndex() {
      const index = await env.USER_DATA.get('users_index');
      return index ? JSON.parse(index) : [];
    }
    async function saveUsersIndex(indexArray) {
      await env.USER_DATA.put('users_index', JSON.stringify(indexArray));
    }
    function safeName(name) {
      return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    }

    // 获取当前用户（用于前端恢复会话）
    if (path === 'user' && request.method === 'GET') {
      const current = await env.USER_DATA.get('current_user');
      return new Response(current || '{}', { headers: corsHeaders });
    }

    // 保存用户基本信息（修改名字、管理员状态等，但不修改密码）
    if (path === 'user' && request.method === 'POST') {
      const user = await request.json();
      const oldName = user.oldName || null;
      const newName = user.name;

      if (!newName) {
        return new Response(JSON.stringify({ error: '用户名不能为空' }), { status: 400, headers: corsHeaders });
      }

      // 检查用户名唯一性（不区分大小写）
      const existingNames = await getUsersIndex();
      const nameExists = existingNames.some(existing => {
        if (oldName && existing.toLowerCase() === oldName.toLowerCase()) return false;
        return existing.toLowerCase() === newName.toLowerCase();
      });
      if (nameExists) {
        return new Response(JSON.stringify({ success: false, error: '用户名已被使用，请更换' }), { status: 409, headers: corsHeaders });
      }

      // 获取原用户记录（如果存在）
      let originalUser = null;
      if (oldName) {
        const oldKey = `user_${safeName(oldName)}`;
        const oldData = await env.USER_DATA.get(oldKey);
        if (oldData) originalUser = JSON.parse(oldData);
      }

      // 构建新用户记录（保留密码和isAdmin等）
      const updatedUser = {
        ...originalUser,
        ...user,
        name: newName
      };
      // 确保密码字段存在（如果没有则设为默认密码）
      if (!updatedUser.password) updatedUser.password = 'dxwbnbfwqb';

      // 删除旧记录（如果改名）
      if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) {
        await env.USER_DATA.delete(`user_${safeName(oldName)}`);
        // 更新索引
        const newIndex = existingNames.filter(name => name.toLowerCase() !== oldName.toLowerCase());
        await saveUsersIndex(newIndex);
      }

      // 保存新记录
      const newKey = `user_${safeName(newName)}`;
      await env.USER_DATA.put(newKey, JSON.stringify(updatedUser));

      // 更新索引（若不存在则添加）
      let index = await getUsersIndex();
      if (!index.some(name => name.toLowerCase() === newName.toLowerCase())) {
        index.push(newName);
        await saveUsersIndex(index);
      }

      // 同时更新 current_user
      await env.USER_DATA.put('current_user', JSON.stringify({ name: newName, isLoggedIn: updatedUser.isLoggedIn, isAdmin: updatedUser.isAdmin }));

      return new Response(JSON.stringify({ success: true, user: { name: newName, isAdmin: updatedUser.isAdmin } }), { headers: corsHeaders });
    }

    // 登录验证
    if (path === 'user/login' && request.method === 'POST') {
      const { name, password } = await request.json();
      if (!name || !password) {
        return new Response(JSON.stringify({ error: '用户名和密码不能为空' }), { status: 400, headers: corsHeaders });
      }

      const key = `user_${safeName(name)}`;
      const userData = await env.USER_DATA.get(key);
      if (userData) {
        const user = JSON.parse(userData);
        if (user.password === password) {
          return new Response(JSON.stringify({ success: true, user: { name: user.name, isAdmin: user.isAdmin } }), { headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({ success: false, error: '密码错误' }), { status: 401, headers: corsHeaders });
        }
      } else {
        // 用户不存在，检查是否为默认密码，是则创建
        if (password === 'dxwbnbfwqb') {
          const newUser = {
            name,
            password,
            isLoggedIn: true,
            isAdmin: false
          };
          await env.USER_DATA.put(key, JSON.stringify(newUser));
          // 更新索引
          let index = await getUsersIndex();
          if (!index.some(n => n.toLowerCase() === name.toLowerCase())) {
            index.push(name);
            await saveUsersIndex(index);
          }
          // 更新 current_user
          await env.USER_DATA.put('current_user', JSON.stringify({ name, isLoggedIn: true, isAdmin: false }));
          return new Response(JSON.stringify({ success: true, user: { name, isAdmin: false } }), { headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({ success: false, error: '用户不存在或密码错误' }), { status: 401, headers: corsHeaders });
        }
      }
    }

    // 修改密码
    if (path === 'user/change-password' && request.method === 'POST') {
      const { name, oldPassword, newPassword } = await request.json();
      if (!name || !oldPassword || !newPassword) {
        return new Response(JSON.stringify({ error: '缺少必要参数' }), { status: 400, headers: corsHeaders });
      }
      const key = `user_${safeName(name)}`;
      const userData = await env.USER_DATA.get(key);
      if (!userData) {
        return new Response(JSON.stringify({ success: false, error: '用户不存在' }), { status: 404, headers: corsHeaders });
      }
      const user = JSON.parse(userData);
      if (user.password !== oldPassword) {
        return new Response(JSON.stringify({ success: false, error: '旧密码错误' }), { status: 401, headers: corsHeaders });
      }
      user.password = newPassword;
      await env.USER_DATA.put(key, JSON.stringify(user));
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 获取所有用户（管理后台）
    if (path === 'users' && request.method === 'GET') {
      const index = await getUsersIndex();
      const users = [];
      for (const name of index) {
        const key = `user_${safeName(name)}`;
        const data = await env.USER_DATA.get(key);
        if (data) {
          const user = JSON.parse(data);
          // 不返回密码
          users.push({ name: user.name, isAdmin: user.isAdmin, isLoggedIn: user.isLoggedIn || false });
        }
      }
      return new Response(JSON.stringify(users), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
