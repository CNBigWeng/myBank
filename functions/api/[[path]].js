// functions/api/[[path]].js
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-name, x-auth-token',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ========== 授权辅助函数 ==========
    async function authorizeRequest(request) {
      const username = request.headers.get('x-user-name');
      const token = request.headers.get('x-auth-token');
      if (!username || !token) return null;

      const key = `user_${safeName(username)}`;
      const userData = await env.USER_DATA.get(key);
      if (!userData) return null;

      const user = JSON.parse(userData);
      if (user.password === token) {
        return user;
      }
      return null;
    }

    function safeName(name) {
      return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
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
      // 需要授权且是管理员
      const user = await authorizeRequest(request);
      if (!user) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: corsHeaders });
      }
      if (!user.isAdmin) {
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
        if (password === 'dxwbnbfwqb') {
          const newUser = {
            name,
            password,
            isLoggedIn: true,
            isAdmin: false
          };
          await env.USER_DATA.put(key, JSON.stringify(newUser));
          let index = await getUsersIndex();
          if (!index.some(n => n.toLowerCase() === name.toLowerCase())) {
            index.push(name);
            await saveUsersIndex(index);
          }
          return new Response(JSON.stringify({ success: true, user: { name, isAdmin: false } }), { headers: corsHeaders });
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

      const existingNames = await getUsersIndex();
      const nameExists = existingNames.some(existing => {
        if (oldName && existing.toLowerCase() === oldName.toLowerCase()) return false;
        return existing.toLowerCase() === newName.toLowerCase();
      });
      if (nameExists) {
        return new Response(JSON.stringify({ success: false, error: '用户名已被使用，请更换' }), { status: 409, headers: corsHeaders });
      }

      const oldKey = `user_${safeName(oldName)}`;
      const oldData = await env.USER_DATA.get(oldKey);
      const originalUser = oldData ? JSON.parse(oldData) : user;
      const updatedUser = {
        ...originalUser,
        ...body,
        name: newName
      };
      if (!updatedUser.password) updatedUser.password = originalUser.password || 'dxwbnbfwqb';

      if (oldName.toLowerCase() !== newName.toLowerCase()) {
        await env.USER_DATA.delete(oldKey);
        const newIndex = existingNames.filter(name => name.toLowerCase() !== oldName.toLowerCase());
        await saveUsersIndex(newIndex);
      }

      const newKey = `user_${safeName(newName)}`;
      await env.USER_DATA.put(newKey, JSON.stringify(updatedUser));

      let index = await getUsersIndex();
      if (!index.some(name => name.toLowerCase() === newName.toLowerCase())) {
        index.push(newName);
        await saveUsersIndex(index);
      }

      return new Response(JSON.stringify({ success: true, user: { name: newName, isAdmin: updatedUser.isAdmin } }), { headers: corsHeaders });
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

      const key = `user_${safeName(user.name)}`;
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

    // 获取所有用户（管理后台，需管理员授权）
    if (path === 'users' && request.method === 'GET') {
      const user = await authorizeRequest(request);
      if (!user || !user.isAdmin) {
        return new Response(JSON.stringify({ error: '需要管理员权限' }), { status: 403, headers: corsHeaders });
      }

      const index = await getUsersIndex();
      const users = [];
      for (const name of index) {
        const key = `user_${safeName(name)}`;
        const data = await env.USER_DATA.get(key);
        if (data) {
          const u = JSON.parse(data);
          users.push({ name: u.name, isAdmin: u.isAdmin, isLoggedIn: u.isLoggedIn || false });
        }
      }
      return new Response(JSON.stringify(users), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
