// server/dockerManager.js
import { Meteor } from 'meteor/meteor';
import { spawn } from 'child_process';
import { promisify } from 'util';

export class DockerManager {
  constructor() {
    this.activeContainers = new Map();
    this.cleanupInterval = null;
    this.startCleanupInterval();
  }

  // Create and start a new SSH container
  async createSSHContainer() {
    try {
      console.log('[DOCKER] Creating new SSH container...');
      
      // Build the Docker image if it doesn't exist
      await this.buildSSHImage();
      
      // Find an available port
      const availablePort = await this.findAvailablePort();
      
      // Run the container
      const containerData = await this.runContainer(availablePort);
      
      // Wait for SSH service to be ready
      await this.waitForSSHReady(availablePort);
      
      // Store container info
      const containerInfo = {
        containerId: containerData.containerId,
        port: availablePort,
        host: 'localhost',
        username: 'root',
        password: 'password123',
        createdAt: new Date(),
        lastActivity: new Date()
      };
      
      this.activeContainers.set(containerData.containerId, containerInfo);
      
      console.log(`[DOCKER] Container created successfully: ${containerData.containerId} on port ${availablePort}`);
      return containerInfo;
      
    } catch (error) {
      console.error('[DOCKER] Error creating container:', error);
      throw new Error(`Failed to create SSH container: ${error.message}`);
    }
  }

  // Build the SSH Docker image
  async buildSSHImage() {
    return new Promise((resolve, reject) => {
      console.log('[DOCKER] Building SSH image...');
      
      // Create Dockerfile content
      const dockerfileContent = `FROM debian:latest

# Install OpenSSH server and update packages
RUN apt-get update && \\
    apt-get install -y openssh-server && \\
    apt-get clean

# Create the directory for the SSH daemon to run
RUN mkdir /var/run/sshd

# Set a root password
RUN echo 'root:password123' | chpasswd

# Allow root login with password by modifying sshd_config
RUN sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config

# Disable PAM to avoid related issues
RUN sed -i 's/UsePAM yes/UsePAM no/g' /etc/ssh/sshd_config

# Expose SSH port
EXPOSE 22

# Start the SSH service in the foreground
CMD ["/usr/sbin/sshd", "-D"]`;

      // Write Dockerfile to temp location
      const fs = require('fs');
      const path = require('path');
      const tempDir = '/tmp/meteor-ssh-container';
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const dockerfilePath = path.join(tempDir, 'Dockerfile');
      fs.writeFileSync(dockerfilePath, dockerfileContent);
      
      // Build the image
      const buildProcess = spawn('docker', [
        'build', 
        '-t', 
        'meteor-ssh-container', 
        tempDir
      ]);

      let buildOutput = '';
      let buildError = '';

      buildProcess.stdout.on('data', (data) => {
        buildOutput += data.toString();
      });

      buildProcess.stderr.on('data', (data) => {
        buildError += data.toString();
      });

      buildProcess.on('close', (code) => {
        if (code === 0) {
          console.log('[DOCKER] Image built successfully');
          resolve();
        } else {
          console.error('[DOCKER] Build failed:', buildError);
          reject(new Error(`Docker build failed: ${buildError}`));
        }
      });

      buildProcess.on('error', (error) => {
        reject(new Error(`Docker build process error: ${error.message}`));
      });
    });
  }

  // Run a new container
  async runContainer(port) {
    return new Promise((resolve, reject) => {
      console.log(`[DOCKER] Starting container on port ${port}...`);
      
      const runProcess = spawn('docker', [
        'run',
        '-d',
        '-p', `${port}:22`,
        'meteor-ssh-container'
      ]);

      let containerId = '';
      let runError = '';

      runProcess.stdout.on('data', (data) => {
        containerId += data.toString().trim();
      });

      runProcess.stderr.on('data', (data) => {
        runError += data.toString();
      });

      runProcess.on('close', (code) => {
        if (code === 0 && containerId) {
          console.log(`[DOCKER] Container started: ${containerId}`);
          resolve({ containerId: containerId.substring(0, 12) });
        } else {
          console.error('[DOCKER] Run failed:', runError);
          reject(new Error(`Docker run failed: ${runError}`));
        }
      });

      runProcess.on('error', (error) => {
        reject(new Error(`Docker run process error: ${error.message}`));
      });
    });
  }

  // Find an available port
  async findAvailablePort(startPort = 2222) {
    const net = require('net');
    
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(startPort, () => {
        const port = server.address().port;
        server.close(() => {
          resolve(port);
        });
      });
      
      server.on('error', () => {
        // Port is in use, try next one
        this.findAvailablePort(startPort + 1).then(resolve);
      });
    });
  }

  // Wait for SSH service to be ready
  async waitForSSHReady(port, maxRetries = 30) {
    const net = require('net');
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(port, 'localhost');
          
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Connection timeout'));
          }, 2000);
          
          socket.on('connect', () => {
            clearTimeout(timeout);
            socket.destroy();
            resolve();
          });
          
          socket.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        
        console.log(`[DOCKER] SSH service ready on port ${port}`);
        return true;
      } catch (error) {
        console.log(`[DOCKER] Waiting for SSH service... (attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    throw new Error('SSH service did not become ready in time');
  }

  // Stop and remove a container
  async stopContainer(containerId) {
    try {
      console.log(`[DOCKER] Stopping container: ${containerId}`);
      
      // Stop the container
      await this.executeDockerCommand(['stop', containerId]);
      
      // Remove the container
      await this.executeDockerCommand(['rm', containerId]);
      
      // Remove from active containers
      this.activeContainers.delete(containerId);
      
      console.log(`[DOCKER] Container stopped and removed: ${containerId}`);
    } catch (error) {
      console.error(`[DOCKER] Error stopping container ${containerId}:`, error);
      throw error;
    }
  }

  // Execute docker command
  async executeDockerCommand(args) {
    return new Promise((resolve, reject) => {
      const process = spawn('docker', args);
      
      let output = '';
      let error = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.stderr.on('data', (data) => {
        error += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`Docker command failed: ${error}`));
        }
      });
      
      process.on('error', (error) => {
        reject(new Error(`Docker process error: ${error.message}`));
      });
    });
  }

  // Get container info
  getContainer(containerId) {
    return this.activeContainers.get(containerId);
  }

  // Get all active containers
  getAllContainers() {
    return Array.from(this.activeContainers.values());
  }

  // Update container last activity
  updateContainerActivity(containerId) {
    const container = this.activeContainers.get(containerId);
    if (container) {
      container.lastActivity = new Date();
    }
  }

  // Start cleanup interval for idle containers
  startCleanupInterval() {
    this.cleanupInterval = Meteor.setInterval(() => {
      this.cleanupIdleContainers();
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  // Cleanup idle containers (default: 30 minutes idle time)
  async cleanupIdleContainers(maxIdleTime = 30 * 60 * 1000) {
    const now = new Date();
    const containersToCleanup = [];

    for (const [containerId, container] of this.activeContainers) {
      const idleTime = now - container.lastActivity;
      if (idleTime > maxIdleTime) {
        containersToCleanup.push(containerId);
      }
    }

    for (const containerId of containersToCleanup) {
      try {
        console.log(`[DOCKER] Cleaning up idle container: ${containerId}`);
        await this.stopContainer(containerId);
      } catch (error) {
        console.error(`[DOCKER] Error cleaning up container ${containerId}:`, error);
      }
    }

    return containersToCleanup.length;
  }

  // Get container statistics
  getContainerStats() {
    const now = new Date();
    const stats = {
      totalContainers: this.activeContainers.size,
      containers: []
    };

    for (const [containerId, container] of this.activeContainers) {
      const duration = now - container.createdAt;
      const idleTime = now - container.lastActivity;
      
      stats.containers.push({
        containerId,
        port: container.port,
        host: container.host,
        createdAt: container.createdAt,
        duration: Math.floor(duration / 1000), // seconds
        idleTime: Math.floor(idleTime / 1000), // seconds
        isActive: idleTime < 300000 // 5 minutes
      });
    }

    return stats;
  }

  // Check if Docker is available
  async checkDockerAvailability() {
    try {
      await this.executeDockerCommand(['--version']);
      return true;
    } catch (error) {
      console.error('[DOCKER] Docker is not available:', error);
      return false;
    }
  }

  // Shutdown - cleanup all containers
  async shutdown() {
    console.log('[DOCKER] Shutting down Docker manager...');
    
    if (this.cleanupInterval) {
      Meteor.clearInterval(this.cleanupInterval);
    }
    
    const shutdownPromises = [];
    for (const containerId of this.activeContainers.keys()) {
      shutdownPromises.push(this.stopContainer(containerId));
    }
    
    try {
      await Promise.all(shutdownPromises);
      console.log('[DOCKER] All containers cleaned up');
    } catch (error) {
      console.error('[DOCKER] Error during shutdown:', error);
    }
  }
}

// Export singleton instance
let dockerManagerInstance = null;

export const getDockerManager = () => {
  if (!dockerManagerInstance) {
    dockerManagerInstance = new DockerManager();
  }
  return dockerManagerInstance;
};