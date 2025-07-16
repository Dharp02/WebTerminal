// packages/my-package/server/container-service.js
import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { DockerManager } from './dockerManager.js';

// Use Npm.require for NPM packages in Meteor packages
let express, cors;
if (Meteor.isServer) {
  express = Npm.require('express');
  cors = Npm.require('cors');
}

export class ContainerService {
  constructor() {
    this.dockerManager = new DockerManager();
    this.app = null;
    this.sessionContainers = new Map(); // Track containers by session ID
    this.initialize();
  }

  initialize() {
    // Create Express app for container management
    this.app = express();
    
    // Middleware
    this.app.use(cors());
    this.app.use(express.json());

    // Routes
    this.setupRoutes();

    console.log('[CONTAINER_SERVICE] Container service initialized');
  }

  setupRoutes() {
    // Create container
    this.app.post('/api/containers/create', async (req, res) => {
      try {
        console.log('[CONTAINER_SERVICE] Creating new SSH container...');
        const container = await this.dockerManager.createSSHContainer();

        console.log('[CONTAINER_SERVICE] Container created successfully:', container.containerId);
        res.json({ success: true, container });
      } catch (error) {
        console.error('[CONTAINER_SERVICE] Container creation failed:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // List containers
    this.app.get('/api/containers/list', (req, res) => {
      try {
        const containers = this.dockerManager.getAllContainers();
        res.json({ containers });
      } catch (error) {
        console.error('[CONTAINER_SERVICE] Error listing containers:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Stop container
    this.app.delete('/api/containers/:id', async (req, res) => {
      try {
        await this.dockerManager.stopContainer(req.params.id);
        res.json({ success: true, message: 'Container stopped successfully' });
      } catch (error) {
        console.error('[CONTAINER_SERVICE] Error stopping container:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get container stats
    this.app.get('/api/containers/stats', (req, res) => {
      try {
        const stats = this.dockerManager.getContainerStats();
        res.json(stats);
      } catch (error) {
        console.error('[CONTAINER_SERVICE] Error getting stats:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Health check for container service
    this.app.get('/api/containers/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        service: 'container-service',
        activeContainers: this.dockerManager.activeContainers.size,
        timestamp: new Date().toISOString()
      });
    });

    // End session - cleanup containers for a specific session
    this.app.post('/api/containers/end-session', async (req, res) => {
      try {
        const { sessionId } = req.body;
        console.log(`[CONTAINER_SERVICE] Ending session: ${sessionId}`);
        
        // Find containers associated with this session
        const containersToCleanup = [];
        for (const [containerId, sessionInfo] of this.sessionContainers) {
          if (sessionInfo.sessionId === sessionId) {
            containersToCleanup.push(containerId);
          }
        }
        
        // Stop all containers for this session
        for (const containerId of containersToCleanup) {
          try {
            await this.dockerManager.stopContainer(containerId);
            this.sessionContainers.delete(containerId);
            console.log(`[CONTAINER_SERVICE] Cleaned up container: ${containerId}`);
          } catch (error) {
            console.error(`[CONTAINER_SERVICE] Error cleaning up container ${containerId}:`, error);
          }
        }
        
        res.json({ 
          success: true, 
          message: `Session ended, cleaned up ${containersToCleanup.length} containers`,
          containersCleanedUp: containersToCleanup.length
        });
      } catch (error) {
        console.error('[CONTAINER_SERVICE] Error ending session:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  // Mount the container service routes to the main WebApp
  mountToWebApp() {
    // Add individual route handlers for better integration
    this.addWebAppRoutes();
  }

  addWebAppRoutes() {
    // Container creation endpoint
    WebApp.connectHandlers.use('/api/containers/create', async (req, res, next) => {
      if (req.method !== 'POST') return next();
      
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        console.log('[CONTAINER_SERVICE] Container creation request via WebApp');
        const container = await this.dockerManager.createSSHContainer();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, container }));
      } catch (error) {
        console.error('[CONTAINER_SERVICE] Container creation failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });

    // Container list endpoint
    WebApp.connectHandlers.use('/api/containers/list', (req, res, next) => {
      if (req.method !== 'GET') return next();
      
      try {
        const containers = this.dockerManager.getAllContainers();
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ containers }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

    // Container stats endpoint
    WebApp.connectHandlers.use('/api/containers/stats', (req, res, next) => {
      if (req.method !== 'GET') return next();
      
      try {
        const stats = this.dockerManager.getContainerStats();
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(stats));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

    // End session endpoint
    WebApp.connectHandlers.use('/api/containers/end-session', async (req, res, next) => {
      if (req.method !== 'POST') return next();
      
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const { sessionId } = JSON.parse(body);
          console.log(`[CONTAINER_SERVICE] Ending session via WebApp: ${sessionId}`);
          
          // Find and cleanup containers for this session
          const containersToCleanup = [];
          for (const [containerId, sessionInfo] of this.sessionContainers) {
            if (sessionInfo.sessionId === sessionId) {
              containersToCleanup.push(containerId);
            }
          }
          
          // Stop all containers for this session
          for (const containerId of containersToCleanup) {
            try {
              await this.dockerManager.stopContainer(containerId);
              this.sessionContainers.delete(containerId);
            } catch (error) {
              console.error(`[CONTAINER_SERVICE] Error cleaning up container ${containerId}:`, error);
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            message: `Session ended, cleaned up ${containersToCleanup.length} containers`,
            containersCleanedUp: containersToCleanup.length
          }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
    });
  }

  // Associate a container with a session
  associateContainerWithSession(containerId, sessionId) {
    this.sessionContainers.set(containerId, {
      sessionId,
      associatedAt: new Date()
    });
  }

  // Get Docker manager instance
  getDockerManager() {
    return this.dockerManager;
  }

  // Get container service stats
  getServiceStats() {
    return {
      totalContainers: this.dockerManager.activeContainers.size,
      sessionContainers: this.sessionContainers.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }

  // Shutdown container service
  async shutdown() {
    console.log('[CONTAINER_SERVICE] Shutting down container service...');
    
    // Cleanup all containers
    if (this.dockerManager) {
      await this.dockerManager.shutdown();
    }
    
    // Clear session tracking
    this.sessionContainers.clear();
    
    console.log('[CONTAINER_SERVICE] Container service shutdown complete');
  }
}

// Singleton instance
let containerServiceInstance = null;

export const getContainerService = () => {
  if (!containerServiceInstance) {
    containerServiceInstance = new ContainerService();
  }
  return containerServiceInstance;
};