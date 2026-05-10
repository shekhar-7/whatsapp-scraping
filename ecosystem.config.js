module.exports = {
  apps: [
    {
      name: "wa-scrapper",
      script: "server.js",
      time: true,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}