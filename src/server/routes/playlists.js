const { Hono } = require('hono');
const {
  importPlaylistFromNetease,
  getPlaylistDetail,
  listSavedPlaylists
} = require('../services/playlist-sync');
const { deletePlaylist, findPlaylistById } = require('../repositories/playlists');

const app = new Hono();

// 请求体上限：导入/刷新只需小 JSON（与 downloads.js 同策略）
const MAX_BODY_BYTES = 1024 * 1024;

// 路由 :id 参数统一校验：Number('abc')/''/Infinity 一律 400
function parsePlaylistId(c) {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function readJsonBody(c) {
  const declaredLength = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    const err = new Error('Payload Too Large');
    err.status = 413;
    throw err;
  }
  try {
    const parsed = await c.req.json();
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function handleError(c, error, tag) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) {
    console.error(`${tag}:`, error);
  }
  return c.json({ code: status, message: error.message || '服务器错误' }, status);
}

app.get('/playlists', (c) => {
  return c.json({ code: 200, playlists: listSavedPlaylists() });
});

app.get('/playlists/:id', (c) => {
  const id = parsePlaylistId(c);
  if (id === null) {
    return c.json({ code: 400, message: '无效的歌单 ID' }, 400);
  }
  const playlist = getPlaylistDetail(id);
  if (!playlist) {
    return c.json({ code: 404, message: '歌单不存在' }, 404);
  }
  return c.json({ code: 200, playlist });
});

app.post('/playlists/import', async (c) => {
  try {
    const body = await readJsonBody(c);
    const neteasePlaylistId = body.neteasePlaylistId || c.req.query('neteasePlaylistId');
    if (!neteasePlaylistId) {
      return c.json({ code: 400, message: '缺少 neteasePlaylistId' }, 400);
    }

    const playlist = await importPlaylistFromNetease(String(neteasePlaylistId), {
      isDefault: Boolean(body.isDefault || c.req.query('isDefault'))
    });

    return c.json({ code: 200, playlist });
  } catch (error) {
    return handleError(c, error, '[playlists/import]');
  }
});

app.post('/playlists/:id/refresh', async (c) => {
  try {
    const id = parsePlaylistId(c);
    if (id === null) {
      return c.json({ code: 400, message: '无效的歌单 ID' }, 400);
    }
    const existing = findPlaylistById(id);
    if (!existing) {
      return c.json({ code: 404, message: '歌单不存在' }, 404);
    }

    const playlist = await importPlaylistFromNetease(existing.neteasePlaylistId, {
      isDefault: existing.isDefault
    });

    return c.json({ code: 200, playlist });
  } catch (error) {
    return handleError(c, error, '[playlists/refresh]');
  }
});

app.delete('/playlists/:id', (c) => {
  const id = parsePlaylistId(c);
  if (id === null) {
    return c.json({ code: 400, message: '无效的歌单 ID' }, 400);
  }
  const deleted = deletePlaylist(id);
  if (!deleted) {
    return c.json({ code: 404, message: '歌单不存在' }, 404);
  }
  return c.json({ code: 200, success: true });
});

module.exports = app;
