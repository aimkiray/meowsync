// src/shared/lrc.js 钉板：五份平行实现收敛后的唯一 LRC 真相源。
// 覆盖时间戳形态/多戳展开/offset 平移钳位/元行滤除/纯文本静态行/
// 译文合并窗口（含 tlyric 继承主 offset）/落盘合并与播放合并同口径/
// 纯音乐占位判定（含真词夹带关键词不误伤）/行净化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLrc, parseLrcTagged, lrcOffsetSec, plainLyricLines,
  mergeTranslations, mergeLrcText, isInstrumentalPlaceholder, cleanLrcLineText,
  neteaseLyricBody,
} from '../src/shared/lrc.js';

test('parseLrc：三种时间戳形态与毫秒右补零', () => {
  const rows = parseLrc('[00:01]a\n[00:02.5]b\n[00:03.05]c\n[00:04:50]d\n[01:02.123]e');
  assert.deepEqual(rows.map(r => r.text), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(rows[0].time, 1);
  assert.equal(rows[1].time, 2.5);   // '.5' = 500ms 右补零
  assert.equal(rows[2].time, 3.05);  // '.05' = 50ms
  assert.equal(rows[3].time, 4.5);   // 冒号分隔毫秒同收
  assert.equal(rows[4].time, 62.123);
});

test('parseLrc：一行多戳展开为多行（同文本不同 time）', () => {
  const rows = parseLrc('[00:01.00][00:05.00]副歌');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.time), [1, 5]);
  assert.ok(rows.every(r => r.text === '副歌'));
});

test('parseLrc：[offset:] 平移——正 offset 提前显示、负漂钳 0', () => {
  const rows = parseLrc('[offset:500]\n[00:01.00]a\n[00:03.00]b');
  assert.deepEqual(rows.map(r => r.time), [0.5, 2.5]);
  // 平移后负值钳 0 不出负数戳
  const neg = parseLrc('[offset:2000]\n[00:01.00]a');
  assert.equal(neg[0].time, 0);
});

test('parseLrc：元标签行不产词条；行内增强戳剥除；空文本戳行滤除', () => {
  const rows = parseLrc('[ti:标题]\n[ar:艺人]\n[00:01.00]词<00:01.20>字\n[00:02.00]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '词字'); // <mm:ss.xx> 内嵌戳剥掉
});

test('parseLrcTagged：保 tag 不保偏移——落盘重建要原样回贴', () => {
  const rows = parseLrcTagged('[offset:500]\n[00:01.00]a\n[ti:x]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tag, '[00:01.00]');
  assert.equal(rows[0].time, 1); // 不施加 offset
});

test('plainLyricLines：剥行首戳再判元行——「先剥戳后判」顺序钉死', () => {
  // [0:05] 是时间戳不是元行：先判元行会被 /^\[[\w-]+:/ 误杀（\w 含数字）
  const rows = plainLyricLines('[00:05]第一句\n[ti:meta]\n纯文本行\n\n[by:某人]');
  assert.deepEqual(rows.map(r => r.text), ['第一句', '纯文本行']);
  assert.ok(rows.every(r => r.time === Infinity));
});

test('mergeTranslations：0.5s 最近邻窗——窗内挂上、窗外不挂、同文不显示', () => {
  const lyrics = parseLrc('[00:01.00]a\n[00:02.00]b\n[00:10.00]c');
  const t = parseLrc('[00:01.30]译a\n[00:02.60]译b\n[00:20.00]远');
  const merged = mergeTranslations(lyrics, t);
  // 01.30 距 01.00 是 0.3s < 0.5s 窗 → 挂上
  assert.equal(merged[0].translation, '译a');
  // b 行的最近邻是译b@2.60（0.6s 出窗）→ 不挂
  assert.equal(merged[1].translation, '');
  assert.equal(merged[2].translation, ''); // 距 10s 出窗
  // AI 未译行回填原文是「占住时间戳防邻行错贴」——同文行赢得最近邻
  // 槽位后输出即置 ''，更远的真译文不越级贴上
  const occupied = mergeTranslations(
    parseLrc('[00:01.00]a'), parseLrc('[00:01.00]a\n[00:01.30]译a'));
  assert.equal(occupied[0].translation, '');
  // 同文译行不重复显示
  const same = mergeTranslations(parseLrc('[00:01.00]原文'), parseLrc('[00:01.00]原文'));
  assert.equal(same[0].translation, '');
});

test('mergeTranslations：tlyric 无自身 [offset:] 继承主层（getLyrics 口径）', () => {
  // 主词 offset=1000ms：词行显示时间=戳-1s；译文层无 offset 标签，
  // 传 fallbackOffsetSec 才能配上窗——否则主词偏移、译文未偏，全灭
  const main = parseLrc('[offset:1000]\n[00:02.00]a'); // 显示 1s
  const tRaw = '[00:01.00]译a'; // 无 offset，显示 1s
  const noFallback = mergeTranslations(main, parseLrc(tRaw));
  assert.equal(noFallback[0].translation, '译a'); // 1s vs 1s 窗内
  const withOffset = mergeTranslations(main, parseLrc(tRaw, lrcOffsetSec('[offset:1000]')));
  // 译文继承主 offset → 显示 0s，距主行 1s 出窗
  assert.equal(withOffset[0].translation, '');
});

test('mergeLrcText：毫秒级歪斜 tlyric 与播放合并产同一份对齐', () => {
  const lrc = '[ti:x]\n[00:01.00]a\n[00:02.00]b';
  const tlyric = '[00:01.04]译a\n[00:02.40]译b'; // 40ms / 400ms 歪斜都在窗内
  // 落盘面：译文行按主行原戳回贴
  const disk = mergeLrcText(lrc, tlyric);
  const diskLines = disk.split('\n');
  assert.ok(diskLines.includes('[00:01.00]译a'));
  assert.ok(diskLines.includes('[00:02.00]译b'));
  // 播放面：同一窗口同样挂上
  const play = mergeTranslations(parseLrc(lrc), parseLrc(tlyric, lrcOffsetSec(lrc)));
  assert.equal(play[0].translation, '译a');
  assert.equal(play[1].translation, '译b');
  // 两面口径一致：播放挂上的行 ⇔ 落盘多出的行。落盘形态里译文行跟在
  // 同戳主行后——与前一行同戳者即译文行
  const diskTranslations = diskLines.slice(1)
    .filter((l, i) => l.slice(0, l.indexOf(']') + 1)
      === diskLines[i].slice(0, diskLines[i].indexOf(']') + 1))
    .map((l) => l.replace(/^\[[^\]]+\]/, ''));
  assert.deepEqual(diskTranslations, play.map(r => r.translation).filter(Boolean));
});

test('mergeLrcText：附属层继承主层 offset；无附属层原样返回', () => {
  const lrc = '[offset:1000]\n[00:02.00]a';
  // tlyric 无 offset——继承主层 1s → 显示 1s 对上主行显示时间 1s
  const merged = mergeLrcText(lrc, '[00:02.00]译a');
  assert.ok(merged.includes('[00:02.00]译a'));
  assert.equal(mergeLrcText(lrc), lrc);
  // 早退路径同样归一：非字符串 lrc（上游畸形）回 '' 而非原样透
  assert.equal(mergeLrcText(undefined), '');
  assert.equal(mergeLrcText(null, '[00:01.00]x'), '');
});

test('isInstrumentalPlaceholder：整词即占位声明才算——真词夹带不误伤', () => {
  assert.equal(isInstrumentalPlaceholder('[99:00.00]纯音乐，请欣赏'), true); // 网易占位戳形
  assert.equal(isInstrumentalPlaceholder('纯音乐'), true);
  assert.equal(isInstrumentalPlaceholder('此歌曲为纯音乐，请欣赏'), true);
  assert.equal(isInstrumentalPlaceholder('[00:01.00]本曲 instrumental'), true);
  // QQ 系各措辞形态（旧整行模板收不全，关键词+短行口径全收）
  assert.equal(isInstrumentalPlaceholder('此歌曲为纯音乐，请您欣赏'), true);
  assert.equal(isInstrumentalPlaceholder('此歌曲为没有填词的纯音乐，请您欣赏'), true);
  assert.equal(isInstrumentalPlaceholder('純音樂，請欣賞'), true);
  assert.equal(isInstrumentalPlaceholder('纯音乐，敬请欣赏'), true);
  // 署名行不计入条数：词/曲署名 + 一条占位行仍是占位词
  assert.equal(isInstrumentalPlaceholder('作曲：某人\n纯音乐，请欣赏'), true);
  // 真词只是夹带「纯音乐」三字（≥3 行正文）绝不误判
  const real = '他说这是一首纯音乐\n可我明明听见人声\n第三行词\n第四行词';
  assert.equal(isInstrumentalPlaceholder(real), false);
  assert.equal(isInstrumentalPlaceholder('纯音乐\n你唱过的旋律\n还在耳边响起'), false);
  // 两行真词只有一行提「纯音乐」——每行都含关键词才算占位
  assert.equal(isInstrumentalPlaceholder('纯音乐前奏很长\n后面全是唱词内容'), false);
  // 超长短行不算占位行（>40 字的关键词夹带是正文）
  assert.equal(isInstrumentalPlaceholder(`纯音乐${'词'.repeat(40)}`), false);
  // 空词/无正文不算占位（无词与占位是两种结局）
  assert.equal(isInstrumentalPlaceholder(''), false);
  assert.equal(isInstrumentalPlaceholder('[ti:x]\n[ar:y]'), false);
});

test('neteaseLyricBody：nolyric/uncollected/占位主词归空，占位主词不透 tlyric', () => {
  assert.deepEqual(neteaseLyricBody({ nolyric: true, lrc: { lyric: 'x' } }), { lrc: '', tlyric: '' });
  assert.deepEqual(neteaseLyricBody({ uncollected: true, lrc: { lyric: 'x' } }), { lrc: '', tlyric: '' });
  // 占位主词连带译文层一并归空——「纯音乐」的 tlyric 没有语义
  assert.deepEqual(neteaseLyricBody({
    lrc: { lyric: '[99:00.00]纯音乐，请欣赏' },
    tlyric: { lyric: '[99:00.00]instrumental, please enjoy' },
  }), { lrc: '', tlyric: '' });
  // 真词 + 官方译文原样透
  assert.deepEqual(neteaseLyricBody({
    lrc: { lyric: '[00:01.00]词' }, tlyric: { lyric: '[00:01.00]译' },
  }), { lrc: '[00:01.00]词', tlyric: '[00:01.00]译' });
  // 非字符串/缺失 lyric 槽与缺词同待遇
  assert.deepEqual(neteaseLyricBody({ lrc: { lyric: 42 } }), { lrc: '', tlyric: '' });
  assert.deepEqual(neteaseLyricBody({}), { lrc: '', tlyric: '' });
});

test('cleanLrcLineText：剥换行/成对括号/落单括号/Cf 零宽——防注入伪造戳', () => {
  assert.equal(cleanLrcLineText('a\nb'), 'a b');
  assert.equal(cleanLrcLineText('词[00:01.00]尾'), '词 尾'); // 幻影时间戳整段剥
  assert.equal(cleanLrcLineText('a]b[c'), 'a b c');
  assert.equal(cleanLrcLineText('x​y'), 'xy'); // ​ Cf 格式字符
  assert.equal(cleanLrcLineText(null), '');
});
