#!/usr/bin/env node

/**
 * MeowSync 一键启动脚本
 * 同时启动前端开发服务器和后端API服务器
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 检查环境变量文件
function checkEnvFile() {
  const envPath = path.join(__dirname, '.env');
  const envExamplePath = path.join(__dirname, '.env.example');
  
  if (!fs.existsSync(envPath)) {
    console.log('\n⚠️  未找到 .env 文件');
    if (fs.existsSync(envExamplePath)) {
      console.log('📋 请复制 .env.example 为 .env 并配置相应参数:');
      console.log('   cp .env.example .env');
    }
    console.log('\n');
    return false;
  }
  return true;
}

// 启动进程
function startProcess(command, args, name, color) {
  const process = spawn(command, args, {
    stdio: 'pipe',
    shell: true,
    cwd: __dirname
  });

  // 输出前缀颜色
  const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m'
  };

  const prefix = `${colors[color]}[${name}]${colors.reset}`;

  process.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(line => line.trim());
    lines.forEach(line => {
      console.log(`${prefix} ${line}`);
    });
  });

  process.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(line => line.trim());
    lines.forEach(line => {
      console.log(`${prefix} ${colors.red}${line}${colors.reset}`);
    });
  });

  process.on('close', (code) => {
    console.log(`${prefix} 进程退出，退出码: ${code}`);
  });

  return process;
}

// 主函数
function main() {
  console.log('\n🎵 MeowSync 启动器\n');
  
  // 检查环境变量文件
  if (!checkEnvFile()) {
    process.exit(1);
  }

  console.log('🚀 正在启动服务...\n');

  // 启动后端API服务器
  const apiServer = startProcess('node', ['netease-api-server.js'], 'API', 'cyan');
  
  // 等待2秒后启动前端服务器
  setTimeout(() => {
    const frontendServer = startProcess('npm', ['run', 'dev'], 'Frontend', 'green');
    
    // 处理退出信号
    process.on('SIGINT', () => {
      console.log('\n\n🛑 正在关闭服务...');
      apiServer.kill('SIGINT');
      frontendServer.kill('SIGINT');
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    });
    
  }, 2000);

  console.log('\n💡 提示:');
  console.log('   - 前端地址: http://localhost:3000');
  console.log('   - API地址: http://localhost:3002');
  console.log('   - 按 Ctrl+C 停止所有服务\n');
}

// 运行
if (require.main === module) {
  main();
}

module.exports = { main };