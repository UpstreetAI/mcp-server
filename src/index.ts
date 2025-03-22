import path from 'path';
import fs from 'fs/promises';
import child_process from 'child_process';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { mkdirp } from 'mkdirp';
import { rimraf } from 'rimraf';
import { PnpmPackageLookup } from "pnpm-package-lookup";

const __dirname = path.join(path.dirname(import.meta.url.replace('file://', '')), '..');

const sortNpmPackages = (packageSpecifiers: string[]) => {
  const npmPackages: string[] = [];
  const githubPackages: string[] = [];
  for (const packageSpecifier of packageSpecifiers) {
    if (packageSpecifier.startsWith('github:')) {
      githubPackages.push(packageSpecifier);
    } else {
      npmPackages.push(packageSpecifier);
    }
  }
  return {
    npm: npmPackages,
    github: githubPackages,
  };
};

class McpServer {
  private serversJson: {
    servers: string[];
  };
  private port: number;
  private internalPortStart: number;
  constructor({
    serversJson,
    port = 3000,
    internalPortStart = 9000,
  }: {
    serversJson: any;
    port?: number;
    internalPortStart?: number;
  }) {
    this.serversJson = serversJson;
    this.port = port;
    this.internalPortStart = internalPortStart;
  }
  async start() {
    // create the packages directory
    const appDir = path.join(__dirname, 'app');
    await rimraf(appDir);
    await mkdirp(appDir);
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({}));
    const appPackagesDir = path.join(appDir, 'packages');
    await mkdirp(appPackagesDir);

    // install the servers with pnpm
    const { servers = [] } = this.serversJson;
    let {
      npm,
      github,
    } = sortNpmPackages(servers);

    // git clone and pnpm build the github packages
    github = await Promise.all(github.map(async (packageSpecifier) => {
      const packageName = packageSpecifier.replace('github:', '');
      const packageSpecifier2 = `https://github.com/${packageName}`;
      const packageBaseName = path.basename(packageSpecifier2);

      const cp = child_process.spawn('git', [
        'clone',
        packageSpecifier2,
      ], {
        cwd: appPackagesDir,
      });
      cp.stdout.pipe(process.stdout);
      cp.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        cp.on('close', (code) => {
          if (code === 0) {
            resolve(null);
          } else {
            reject(new Error(`git clone failed with code ${code}`));
          }
        });
      });

      const cp2 = child_process.spawn('pnpm', ['install'], {
        cwd: path.join(appPackagesDir, packageBaseName),
      });
      cp2.stdout.pipe(process.stdout);
      cp2.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        cp2.on('close', (code) => {
          if (code === 0) {
            resolve(null);
          } else {
            reject(new Error(`pnpm install failed with code ${code}`));
          }
        });
      });

      const cp3 = child_process.spawn('pnpm', ['build'], {
        cwd: path.join(appPackagesDir, packageBaseName),
      });
      cp3.stdout.pipe(process.stdout);
      cp3.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        cp3.on('close', (code) => {
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
        path.join(__dirname, 'node_modules', '.bin', 'pnpm'),
        [
          'install',
          ...installPackages,
        ],
        {
          cwd: appDir,
        },
      );
      cp.stdout.pipe(process.stdout);
      cp.stderr.pipe(process.stderr);
      cp.on('close', (code) => {
        if (code === 0) {
          resolve(null);
        } else {
          reject(new Error(`pnpm install failed with code ${code}`));
        }
      });
      cp.on('error', (err) => {
        reject(err);
      });
    });

    // Start MCP servers from configuration
    const pnpmLockYamlPath = path.resolve(appDir, "pnpm-lock.yaml");
    const pnpmPackageLookup = new PnpmPackageLookup({
      pnpmLockYamlPath,
    });
    const serverPortMap = new Map<string, number>();
    const cps = await Promise.all(installPackages.map(async (server: string, index: number) => {
      const packageSpecifier = await pnpmPackageLookup.getPackageNameBySpecifier(server);
      if (!packageSpecifier) {
        throw new Error(`Package specifier not found: ${server}`);
      }
      const port = this.internalPortStart + index;
      const dirName = JSON.stringify(path.join(appDir, 'node_modules', packageSpecifier));

      const command = `pnpm --dir ${dirName} start`;
      console.log('pnpm command', command);
      const cp = child_process.spawn(path.join(__dirname, 'node_modules', '.bin', 'supergateway'), [
        '--stdio',
        command,
        '--port',
        port + '',
      ], {
        stdio: 'pipe',
        env: process.env,
      });
      cp.stdout.pipe(process.stdout);
      cp.stderr.pipe(process.stderr);
      
      // Store server name and port mapping
      serverPortMap.set(server, port);

      return {
        server,
      };
    }));

    {
      // Create a new Hono app instance
      const app = new Hono();

      // Define routes
      app.get('/', (c) => {
        return c.json({
            message: 'MCP Server is running'
        });
      });
      cps.forEach((cp: {
        server: string,
      }) => {
        app.all(`/${cp.server}/*`, async (c) => {
          const targetPort = serverPortMap.get(cp.server);
          if (!targetPort) {
            return c.json({ error: 'Server not found' }, 404);
          }
          
          const req = c.req.raw;
          const target = `http://localhost:${targetPort}`;

          const proxyRes = await fetch(target + c.req.path, {
            method: req.method,
            body: req.body,
            headers: req.headers,
          });
          return proxyRes;
        });
      });

      // Start the server
      serve({
        fetch: app.fetch,
        port: this.port,
      }, () => {
        console.log(`MCP Server is running on port ${this.port}`);
      });
    }
  }
}
export default McpServer;

// Add command line parsing if this is the main module
if (import.meta.url === import.meta.resolve(process.argv[1])) {
  dotenv.config();

  const program = new Command();
  
  program
    .name('mcp-server')
    .description('A server for managing MCP (Model Context Protocol) providers')
    .version('0.0.1')
    .argument('[config]', 'Path to servers configuration file', './mcp-servers.json')
    .option('-p, --port <port>', 'Port to run the server on', '3000')
    .action(async (config, options) => {
      // Set port from command line
      const port = Number(options.port) || undefined;
      
      try {
        // Load servers configuration from the specified path
        const configPath = path.resolve(config);
        
        const fileContent = await fs.readFile(configPath, 'utf-8');
        // console.log('git file content', fileContent);
        const serversJson = JSON.parse(fileContent);
        
        // Start the server
        const server = new McpServer({ serversJson, port });
        await server.start();
      } catch (error) {
        console.error('Failed to start MCP server:', error);
        process.exit(1);
      }
    });
  program.parse();
}
