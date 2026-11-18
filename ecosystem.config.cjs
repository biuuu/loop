module.exports = {
  apps: [
    {
      name: 'loop',
      cwd: __dirname,
      script: './dist/server/index.js',
      node_args: ['--env-file-if-exists=.env'],
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production' },
    },
  ],
};
