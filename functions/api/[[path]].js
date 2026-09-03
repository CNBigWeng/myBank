// functions/api/[[path]].js
export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // 处理 OPTIONS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (path === 'news' && request.method === 'GET') {
      // 获取新闻列表
      const list = await env.NEWS_DATA.list();
      const newsArray = [];
      for (const key of list.keys) {
        const value = await env.NEWS_DATA.get(key.name);
        newsArray.push(JSON.parse(value));
      }
      // 按时间排序
      newsArray.sort((a, b) => new Date(b.time) - new Date(a.time));
      return new Response(JSON.stringify(newsArray), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (path === 'news' && request.method === 'POST') {
      // 保存新闻（新增一条）
      const news = await request.json();
      const id = news.id || Date.now().toString();
      news.id = id;
      await env.NEWS_DATA.put(id, JSON.stringify(news));
      return new Response(JSON.stringify({ success: true, id }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (path.startsWith('news/') && request.method === 'DELETE') {
      // 删除新闻
      const id = path.split('/')[1];
      await env.NEWS_DATA.delete(id);
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (path === 'user' && request.method === 'GET') {
      // 获取当前用户状态
      const user = await env.USER_DATA.get('current_user');
      return new Response(user || '{}', { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (path === 'user' && request.method === 'POST') {
      // 保存用户状态
      const user = await request.json();
      await env.USER_DATA.put('current_user', JSON.stringify(user));
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
}
