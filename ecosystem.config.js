module.exports = {
  apps: [
    {
      name: "uptime-tracker",
      script: "npm",
      args: "run start",
      cwd: "/var/www/uptime-tracker",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      // Dedicated monitoring worker (WRK-01, D-20) — the single tsup entry
      // built by the same `pnpm build` as the web app (D-06/D-11). First
      // release follows runbook §4a: `pm2 start ecosystem.config.js --only
      // uptime-worker` (never `pm2 restart` on an unregistered name).
      //
      // wait_ready + the two pins are deliberate raises over PM2 defaults
      // (listen_timeout 3000 / kill_timeout 1600): the worker boots queue
      // workers, re-declares job schedulers, and pings Redis + Postgres
      // before signaling process.send('ready') (WRK-08); kill_timeout 20000
      // is the runbook's non-negotiable floor so in-flight jobs drain
      // before SIGKILL (P-1/DEP-01, 01-04 pins).
      name: "uptime-worker",
      script: "node",
      args: "dist/worker.js",
      cwd: "/var/www/uptime-tracker",
      wait_ready: true,
      listen_timeout: 30000,
      kill_timeout: 20000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
