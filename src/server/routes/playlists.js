const { Hono } = require('hono');
const {
  importPlaylistFromNetease,
  getPlaylistDetail,
  listSavedPlaylists
} = require('../services/playlist-sync');
const { findPlaylistById } = require('../repositories/playlists');
const { deletePlaylistCascade } = require('../services/download-manager');
const { readJsonBody } = require('../lib/http-body');
const { fail, handleError } = require('../lib/http-error');

const app = new Hono();

// 路由 :id 参数统一校验：只收纯十进制——Number() 会放过 '1e5'/'0x10'/' 3 '
function parsePlaylistId(c) {
  const raw = c.req.param('id');
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

app.get('/playlists', (c) => {
  // 同步 better-sqlite3 调用也会抛（SQLITE_BUSY/IOERR）——无 catch 会冒泡到
  // app.onError 返回英文 'Internal Server Error'，与本文件错误契约不一致
  try {
    return c.json({ code: 200, playlists: listSavedPlaylists() });
  } catch (error) {
    return handleError(c, error, '[playlists/list]');
  }
});

app.get('/playlists/:id', (c) => {
  const id = parsePlaylistId(c);
  if (id === null) {
    return fail(c, 400, '无效的歌单 ID');
  }
  try {
    const playlist = getPlaylistDetail(id);
    if (!playlist) {
      return fail(c, 404, '歌单不存在');
    }
    return c.json({ code: 200, playlist });
  } catch (error) {
    return handleError(c, error, '[playlists/detail]');
  }
});

app.post('/playlists/import', async (c) => {
  try {
    const body = await readJsonBody(c);
    const neteasePlaylistId = body.neteasePlaylistId || c.req.query('neteasePlaylistId');
    if (!neteasePlaylistId) {
      return c.json({ code: 400, message: '缺少 neteasePlaylistId' }, 400);
    }

    const playlist = await importPlaylistFromNetease(String(neteasePlaylistId), {
      // 字符串 'false'/'0' 按布尔 false 处理（Boolean('false') === true 的坑）
      isDefault: body.isDefault === true || c.req.query('isDefault') === 'true'
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

app.delete('/playlists/:id', async (c) => {
  const id = parsePlaylistId(c);
  if (id === null) {
    return c.json({ code: 400, message: '无效的歌单 ID' }, 400);
  }
  try {
    // 级联删除：deletingPlaylists 锁持有到行删除之后才释放，排空清理也在锁内
    const deleted = await deletePlaylistCascade(id);
    if (!deleted) {
      return c.json({ code: 404, message: '歌单不存在' }, 404);
    }
    return c.json({ code: 200, success: true });
  } catch (error) {
    return handleError(c, error, '[playlists/delete]');
  }
});

module.exports = app;
