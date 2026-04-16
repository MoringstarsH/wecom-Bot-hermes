module.exports = {
  apps: [
    {
      name: 'wecom-bot-hermes',
      script: './bridge.mjs',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      // 日志格式
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // 错误日志路径
      error_file: './logs/err.log',
      // 标准输出日志路径
      out_file: './logs/out.log',
      // 合并日志路径
      log_file: './logs/combined.log',
      // 在日志中显示时间戳
      time: true,
    },
  ],
};
