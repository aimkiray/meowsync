const { Hono } = require('hono');
const {
  importPlaylistFromNetease,
  getPlaylistDetail,
  listSavedPlaylists
} = require('../services/playlist-sync');
const { deletePlaylist, findPlaylistById } = require('../repositories/playlists');
const { deletePlaylistFiles } = require('../services/download-manager');
const { readJsonBody } = require('../lib/http-body');

const app = new Hono();

// 路由 :id 参数统一校验：Number('abc')/''/Infinity 一律 400
function parsePlaylistId(c) {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
}



function handleError(c, error, tag) {
  // err.status 标记的是业务层自撰消息，可回传（含 5xx 业务错误如导入上游失败）；
  // 未标记的内部异常一律 500 且不带细节
  const marked = Number.isInteger(error.status) && error.status >= 400 && error.status < 600;
  if (marked) {
    if (error.status >= 500) console.error(`${tag}:`, error);
    return c.json({ code: error.status, message: error.message || '请求失败' }, error.status);
  }
  console.error(`${tag}:`, error);
  return c.json({ code: 500, message: '服务器错误' }, 500);
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
    // 先中止该歌单的活跃队列/单曲任务并排空清理文件，再删行——否则磁盘上留孤儿文件
    await deletePlaylistFiles(id);
    const deleted = deletePlaylist(id);
    if (!deleted) {
      return c.json({ code: 404, message: '歌单不存在' }, 404);
    }
    return c.json({ code: 200, success: true });
  } catch (error) {
    return handleError(c, error, '[playlists/delete]');
  }
});

module.exports = app;
