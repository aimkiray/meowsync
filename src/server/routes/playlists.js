const { Hono } = require('hono');
const {
  importPlaylistFromNetease,
  getPlaylistDetail,
  listSavedPlaylists
} = require('../services/playlist-sync');
const { deletePlaylist, findPlaylistById } = require('../repositories/playlists');

const app = new Hono();

app.get('/playlists', (c) => {
  return c.json({ code: 200, playlists: listSavedPlaylists() });
});

app.get('/playlists/:id', (c) => {
  const playlist = getPlaylistDetail(Number(c.req.param('id')));
  if (!playlist) {
    return c.json({ code: 404, message: '歌单不存在' }, 404);
  }
  return c.json({ code: 200, playlist });
});

app.post('/playlists/import', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const neteasePlaylistId = body.neteasePlaylistId || c.req.query('neteasePlaylistId');
    if (!neteasePlaylistId) {
      return c.json({ code: 400, message: '缺少 neteasePlaylistId' }, 400);
    }

    const playlist = await importPlaylistFromNetease(String(neteasePlaylistId), {
      isDefault: Boolean(body.isDefault || c.req.query('isDefault'))
    });

    return c.json({ code: 200, playlist });
  } catch (error) {
    console.error('[playlists/import]', error);
    return c.json({ code: 500, message: error.message || '导入歌单失败' }, 500);
  }
});

app.post('/playlists/:id/refresh', async (c) => {
  try {
    const existing = findPlaylistById(Number(c.req.param('id')));
    if (!existing) {
      return c.json({ code: 404, message: '歌单不存在' }, 404);
    }

    const playlist = await importPlaylistFromNetease(existing.neteasePlaylistId, {
      isDefault: existing.isDefault
    });

    return c.json({ code: 200, playlist });
  } catch (error) {
    console.error('[playlists/refresh]', error);
    return c.json({ code: 500, message: error.message || '刷新歌单失败' }, 500);
  }
});

app.delete('/playlists/:id', (c) => {
  const deleted = deletePlaylist(Number(c.req.param('id')));
  if (!deleted) {
    return c.json({ code: 404, message: '歌单不存在' }, 404);
  }
  return c.json({ code: 200, success: true });
});

module.exports = app;
