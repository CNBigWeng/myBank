// functions/api/[[path]].js
// Cloudflare Pages Functions 脚本，处理 /api/news 和 /api/user 路由
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

  // 处理预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ========== 新闻路由 ==========
    if (path === 'news' && request.method === 'GET') {
      // 获取所有新闻列表
      const list = await env.NEWS_DATA.list();
      const newsArray = [];
      for (const key of list.keys) {
        const value = await env.NEWS_DATA.get(key.name);
        if (value) {
          newsArray.push(JSON.parse(value));
        }
      }
      // 按时间倒序排序（假设有时间字段，没有则保持原样）
      newsArray.sort((a, b) => new Date(b.time) - new Date(a.time));
      return new Response(JSON.stringify(newsArray), { headers: corsHeaders });
    }

    if (path === 'news' && request.method === 'POST') {
      const body = await request.json();
      // 如果发送的是数组，则全量替换
      if (Array.isArray(body)) {
        // 清空现有数据
        const existingKeys = await env.NEWS_DATA.list();
        for (const key of existingKeys.keys) {
          await env.NEWS_DATA.delete(key.name);
        }
        // 写入新数据
        for (const news of body) {
          const id = news.id || Date.now().toString();
          news.id = id;
          await env.NEWS_DATA.put(id, JSON.stringify(news));
        }
        return new Response(JSON.stringify({ success: true, count: body.length }), { headers: corsHeaders });
      } else {
        // 如果发送的是单个新闻对象，则添加或更新
        const news = body;
        const id = news.id || Date.now().toString();
        news.id = id;
        await env.NEWS_DATA.put(id, JSON.stringify(news));
        return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
      }
    }

    // 删除单条新闻：/api/news/:id
    if (path.startsWith('news/') && request.method === 'DELETE') {
      const id = path.split('/')[1];
      if (!id) {
        return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: corsHeaders });
      }
      await env.NEWS_DATA.delete(id);
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ========== 用户路由 ==========
    if (path === 'user' && request.method === 'GET') {
      const user = await env.USER_DATA.get('current_user');
      return new Response(user || '{}', { headers: corsHeaders });
    }

    if (path === 'user' && request.method === 'POST') {
      const user = await request.json();
      await env.USER_DATA.put('current_user', JSON.stringify(user));
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 未匹配的路由
    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
