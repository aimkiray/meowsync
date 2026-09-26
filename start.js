#!/usr/bin/env node

/**
 * MeowSync 一键启动脚本
 * 同时启动前端开发服务器和后端API服务器
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 读取 .env 用于端口提示（子进程各自也会自行加载）
require('dotenv').config();

const children = new Set();
let shuttingDown = false;

const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

// 检查环境变量文件（仅提示：所有变量均有默认值，不阻断启动）
function checkEnvFile() {
  const envPath = path.join(__dirname, '.env');
  const envExamplePath = path.join(__dirname, '.env.example');
  if (!fs.existsSync(envPath)) {
    console.log('\n⚠️  未找到 .env 文件，将使用默认配置');
    if (fs.existsSync(envExamplePath)) {
      console.log('📋 如需自定义配置，请执行: cp .env.example .env');
    }
    console.log('');
  }
}

// 逐行输出子进程日志（缓冲半行，兼容 \r\n）
function pipeLines(stream, prefix, paint) {
  let buf = '';
  stream.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line.trim()) console.log(`${prefix} ${paint(line)}`);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) console.log(`${prefix} ${paint(buf)}`);
  });
}

function stopChild(child, signal) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill(signal);
  } catch { /* 进程已退出 */ }
}

// 全部子进程退出后退出主进程；超时未退出的强杀
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n\n🛑 正在关闭服务...');

  for (const child of children) stopChild(child, 'SIGINT');

  setTimeout(() => {
    for (const child of children) stopChild(child, 'SIGKILL');
    process.exit(code);
  }, 1000).unref();

  if (children.size === 0) process.exit(code);
}

// 信号处理必须在 spawn 之前注册，否则启动初期的 Ctrl+C 会漏杀子进程
function registerSignalHandlers() {
  const onSignal = () => {
    if (shuttingDown) {
      process.exit(130); // 第二次 Ctrl+C 强制退出
    }
    shutdown(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// 直接以 node 可执行文件启动，不经 shell/npm——避免 cmd/sh 壳进程被杀后遗留孤儿进程
function startProcess(args, name, color) {
  const child = spawn(process.execPath, args, {
    stdio: 'pipe',
    cwd: __dirname
  });
  children.add(child);

  const prefix = `${colors[color]}[${name}]${colors.reset}`;
  pipeLines(child.stdout, prefix, (s) => s);
  pipeLines(child.stderr, prefix, (s) => `${colors.red}${s}${colors.reset}`);

  child.on('error', (err) => {
    console.error(`${prefix} 启动失败:`, err.message);
    shutdown(1);
  });

  child.on('close', (code) => {
    children.delete(child);
    console.log(`${prefix} 进程退出，退出码: ${code}`);
    // 非主动关闭时子进程异常退出 → 连带关闭其他服务并传播退出码
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error('子进程异常退出，正在关闭其他服务...');
      shutdown(code ?? 1);
    } else if (shuttingDown && children.size === 0) {
      process.exit(0);
    }
  });

  return child;
}

// 主函数
function main() {
  console.log('\n🎵 MeowSync 启动器\n');

  registerSignalHandlers();
  checkEnvFile();

  console.log('🚀 正在启动服务...\n');

  // 启动后端API服务器
  startProcess(['netease-api-server.js'], 'API', 'cyan');

  // 启动前端开发服务器（直接调 vite 入口，不经 npm，便于信号直达）
  const viteBin = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
  startProcess([viteBin], 'Frontend', 'green');

  const apiPort = process.env.API_PORT || process.env.PORT || '3002';
  const vitePort = process.env.VITE_PORT || '3000';
  console.log('\n💡 提示:');
  console.log(`   - 前端地址: http://localhost:${vitePort}`);
  console.log(`   - API地址: http://localhost:${apiPort}`);
  console.log('   - 按 Ctrl+C 停止所有服务\n');
}

// 运行
if (require.main === module) {
  main();
}

module.exports = { main };
