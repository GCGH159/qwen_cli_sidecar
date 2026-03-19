module.exports = {
  apps: [
    {
      name: "claude-sidecar",
      cwd: "/root/pr/chatbot-go/claude-sidecar",
      script: "dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "debug",
      },
    },
  ],
};
