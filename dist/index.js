#!/usr/bin/env node

// src/index.ts
import path from "path";
import fs from "fs/promises";
import child_process from "child_process";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { Command } from "commander";
import { mkdirp } from "mkdirp";
import { rimraf } from "rimraf";
import { PnpmPackageLookup } from "pnpm-package-lookup";
var __dirname = path.join(path.dirname(import.meta.url.replace("file://", "")), "..");
var sortNpmPackages = (packageSpecifiers) => {
  const npmPackages = [];
  const githubPackages = [];
  for (const packageSpecifier of packageSpecifiers) {
    if (packageSpecifier.startsWith("github:")) {
      githubPackages.push(packageSpecifier);
    } else {
      npmPackages.push(packageSpecifier);
    }
  }
  return {
    npm: npmPackages,
    github: githubPackages
  };
};
var SimpleMcpServer = class {
  constructor({
    serversJson,
    port = 3e3,
    internalPortStart = 9e3
  }) {
    this.serversJson = serversJson;
    this.port = port;
    this.internalPortStart = internalPortStart;
  }
  async start() {
    const appDir = path.join(__dirname, "app");
    await rimraf(appDir);
    await mkdirp(appDir);
    await fs.writeFile(path.join(appDir, "package.json"), JSON.stringify({}));
    const appPackagesDir = path.join(appDir, "packages");
    await mkdirp(appPackagesDir);
    const {
      servers = [],
      envs = Array(servers.length).fill(null).map(() => ({}))
    } = this.serversJson;
    let {
      npm,
      github
    } = sortNpmPackages(servers);
    const allServers = [...npm, ...github];
    github = await Promise.all(github.map(async (packageSpecifier) => {
      const packageName = packageSpecifier.replace("github:", "");
      const packageSpecifier2 = `https://github.com/${packageName}`;
      const packageBaseName = path.basename(packageSpecifier2);
      const cp = child_process.spawn("git", [
        "clone",
        packageSpecifier2
      ], {
        cwd: appPackagesDir
      });
      cp.stdout.pipe(process.stdout);
      cp.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        cp.on("close", (code) => {
          if (code === 0) {
            resolve(null);
          } else {
            reject(new Error(`git clone failed with code ${code}`));
          }
        });
      });
      const cp2 = child_process.spawn("pnpm", ["install"], {
        cwd: path.join(appPackagesDir, packageBaseName)
      });
      cp2.stdout.pipe(process.stdout);
      cp2.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        cp2.on("close", (code) => {
          if (code === 0) {
            resolve(null);
          } else {
            reject(new Error(`pnpm install failed with code ${code}`));
          }
        });
      });
      const cp3 = child_process.spawn("pnpm", ["build"], {
        cwd: path.join(appPackagesDir, packageBaseName)
      });
      cp3.stdout.pipe(process.stdout);
      cp3.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        cp3.on("close", (code) => {
          if (code === 0) {
            resolve(null);
          } else {
            reject(new Error(`pnpm build failed with code ${code}`));
          }
        });
      });
      return `file:${path.join(appPackagesDir, packageBaseName)}`;
    }));
    const installPackages = [...npm, ...github];
    await new Promise((resolve, reject) => {
      const cp = child_process.spawn(
        path.join(__dirname, "node_modules", ".bin", "pnpm"),
        [
          "install",
          ...installPackages
        ],
        {
          cwd: appDir
        }
      );
      cp.stdout.pipe(process.stdout);
      cp.stderr.pipe(process.stderr);
      cp.on("close", (code) => {
        if (code === 0) {
          resolve(null);
        } else {
          reject(new Error(`pnpm install failed with code ${code}`));
        }
      });
      cp.on("error", (err) => {
        reject(err);
      });
    });
    const pnpmLockYamlPath = path.resolve(appDir, "pnpm-lock.yaml");
    const pnpmPackageLookup = new PnpmPackageLookup({
      pnpmLockYamlPath
    });
    const serverPortMap = /* @__PURE__ */ new Map();
    const cps = await Promise.all(installPackages.map(async (server, index) => {
      const packageSpecifier = await pnpmPackageLookup.getPackageNameBySpecifier(server);
      if (!packageSpecifier) {
        throw new Error(`Package specifier not found: ${server}`);
      }
      const port = this.internalPortStart + index;
      const dirName = path.join(appDir, "node_modules", packageSpecifier);
      const env = envs[index];
      const envString = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
      const command = `${envString} pnpm --dir ${JSON.stringify(dirName)} start`;
      console.log("plugin command", command);
      const cp = child_process.spawn(path.join(__dirname, "node_modules", ".bin", "supergateway"), [
        "--stdio",
        command,
        "--port",
        port + ""
      ], {
        stdio: "pipe",
        env: process.env
      });
      cp.stdout.pipe(process.stdout);
      cp.stderr.pipe(process.stderr);
      const serverRef = encodeURIComponent(allServers[index]);
      serverPortMap.set(serverRef, port);
      return {
        serverRef
      };
    }));
    {
      const app = new Hono();
      app.get("/", (c) => {
        return c.json({
          message: "MCP Server is running"
        });
      });
      cps.forEach((cp) => {
        app.all(`/${cp.serverRef}`, async (c) => {
          const targetPort = serverPortMap.get(cp.serverRef);
          if (!targetPort) {
            return c.json({ error: "Server not found" }, 404);
          }
          const req = c.req.raw;
          const target = `http://localhost:${targetPort}/sse`;
          const proxyRes = await fetch(target, {
            method: req.method,
            body: req.body,
            headers: req.headers
          });
          return proxyRes;
        });
      });
      serve({
        fetch: app.fetch,
        port: this.port
      }, () => {
        console.log(`MCP Server is running on port ${this.port}`);
        console.log("running servers:\n", allServers.map((server) => `  http://localhost:${this.port}/${encodeURIComponent(server)}`).join("\n"));
      });
    }
  }
};
var index_default = SimpleMcpServer;
if (import.meta.url === import.meta.resolve(process.argv[1])) {
  dotenv.config();
  const program = new Command();
  program.name("simple-mcp-server").description("A server for managing MCP (Model Context Protocol) providers").version("0.0.1").argument("[config]", "Path to servers configuration file").action(async (config) => {
    if (!config) {
      throw new Error("No servers configuration file argument provided");
    }
    const port = Number(process.env.PORT) || void 0;
    try {
      const configPath = path.resolve(config);
      const fileContent = await fs.readFile(configPath, "utf-8");
      const serversJson = JSON.parse(fileContent);
      const server = new SimpleMcpServer({ serversJson, port });
      await server.start();
    } catch (error) {
      console.error("Failed to start MCP server:", error);
      process.exit(1);
    }
  });
  program.parse();
}
export {
  index_default as default
};
//# sourceMappingURL=index.js.map