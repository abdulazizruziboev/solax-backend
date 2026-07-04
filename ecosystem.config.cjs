module.exports = {
  apps: [
    {
      name: 'solax-backend',
      script: 'src/server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      time: true,
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Tashkent',
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
