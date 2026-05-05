module.exports = {
  apps: [
    {
      name: 'adhan-caster',
      script: 'media-caster/boot.js',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'adb-keeper',
      script: 'media-caster/adb_keepalive.js',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'auto-updater',
      script: 'media-caster/auto_updater.js',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '120M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
