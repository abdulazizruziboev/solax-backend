module.exports = {
  apps: [
    {
      name: 'solax-app',
      script: 'index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      time: true,
      restart_delay: 3000,
    },
  ],
};
