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
        if (value) {
          newsArray.push(JSON.parse(value));
        }
      }
      newsArray.sort((a, b) => new Date(b.time) - new Date(a.time));
      return new Response(JSON.stringify(newsArray), { headers: corsHeaders });
    }

    if (path === 'news' && request.method === 'POST') {
      const body = await request.json();
      if (Array.isArray(body)) {
        // 全量替换
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

    // ========== 用户路由（支持多用户） ==========
    if (path === 'user' && request.method === 'POST') {
    const user = await request.json();
    // 保存当前用户
    await env.USER_DATA.put('current_user', JSON.stringify(user));
    // 同时保存到用户列表
    if (user.name && user.isLoggedIn) {
        const safeName = user.name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
        const userKey = `user_${safeName}`;
        await env.USER_DATA.put(userKey, JSON.stringify(user));
        // 更新索引
        let index = await env.USER_DATA.get('users_index');
        let users = index ? JSON.parse(index) : [];
        if (!users.includes(user.name)) {
            users.push(user.name);
            await env.USER_DATA.put('users_index', JSON.stringify(users));
        }
    }
    return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 获取所有用户列表
    if (path === 'users' && request.method === 'GET') {
      const index = await env.USER_DATA.get('users_index');
      const names = index ? JSON.parse(index) : [];
      const users = [];
      for (const name of names) {
        const safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
        const data = await env.USER_DATA.get(`user_${safeName}`);
        if (data) {
          users.push(JSON.parse(data));
        }
      }
      return new Response(JSON.stringify(users), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
