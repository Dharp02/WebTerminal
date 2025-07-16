// packages/my-package/server/main.js
import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { Server } from 'socket.io';
import { Client } from 'ssh2';
import { getContainerService } from './container/ContainerService.js';

// Use Npm.require for NPM packages in Meteor packages
let fetch;
if (Meteor.isServer) {
  fetch = Npm.require('node-fetch');
}

// Terminal server class for handling SSH connections with integrated container service
export class TerminalServer {
  constructor() {
    this.activeSessions = new Map();
    this.io = null;
    this.cleanupInterval = null;
    this.healthInterval = null;
    this.containerService = null;
    this.initialize();
  }

  initialize() {
    // Initialize container service first
    this.containerService = getContainerService();
    this.containerService.mountToWebApp();

    // Initialize Socket.IO server
    this.io = new Server(WebApp.httpServer, {
      cors: { 
        origin: '*', 
        methods: ['GET', 'POST'] 
      },
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // Setup socket event handlers
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    // Setup cleanup interval
    this.cleanupInterval = Meteor.setInterval(() => {
      this.cleanupIdleSessions();
    }, 5 * 60 * 1000); // Every 5 minutes

    // Start health monitoring
    this.startHealthMonitoring();

    console.log('Terminal server initialized with integrated container service');
  }

  handleConnection(socket) {
    console.log(`Terminal client connected: ${socket.id}`);

    // Track connection state
    let isSocketConnected = true;
    let lastConnectionAttempt = 0;
    const MIN_CONNECTION_INTERVAL = 2000; // 2 seconds between connection attempts

    // Handle SSH connection request with rate limiting
    socket.on('terminal:connect', async (credentials) => {
      if (!isSocketConnected) return;
      
      // Simple rate limiting - prevent rapid reconnection attempts
      const now = Date.now();
      if (now - lastConnectionAttempt < MIN_CONNECTION_INTERVAL) {
        socket.emit('terminal:error', { 
          message: 'Too many connection attempts. Please wait before trying again.' 
        });
        return;
      }
      lastConnectionAttempt = now;
      
      // Check if already connecting or connected
      const session = this.activeSessions.get(socket.id);
      if (session && (session.isConnecting || session.isConnected)) {
        socket.emit('terminal:error', { 
          message: 'Connection already in progress or established' 
        });
        return;
      }
      
      await this.handleSSHConnect(socket, credentials);
    });

    // Handle container creation request - integrated directly
    socket.on('terminal:create-container', async () => {
      if (!isSocketConnected) return;
      
      try {
        console.log(`[TERMINAL] Creating container for session: ${socket.id}`);
        socket.emit('terminal:container-creating', { message: 'Creating your container...' });
        
        // Use integrated container service
        const dockerManager = this.containerService.getDockerManager();
        const containerInfo = await dockerManager.createSSHContainer();
        
        // Associate container with session
        this.containerService.associateContainerWithSession(containerInfo.containerId, socket.id);
        
        console.log(`[TERMINAL] Container created: ${containerInfo.containerId}`);
        socket.emit('terminal:container-created', containerInfo);
        
        // Wait a moment for the container to be fully ready, then connect
        setTimeout(() => {
          if (isSocketConnected) {
            this.handleSSHConnect(socket, {
              host: containerInfo.host,
              port: containerInfo.port,
              username: containerInfo.username,
              password: containerInfo.password,
              containerId: containerInfo.containerId
            });
          }
        }, 2000);
        
      } catch (error) {
        console.error('[TERMINAL] Container creation failed:', error);
        socket.emit('terminal:error', { 
          message: `Failed to create container: ${error.message}` 
        });
      }
    });

    // Handle terminal input
    socket.on('terminal:input', (data) => {
      if (!isSocketConnected) return;
      this.handleTerminalInput(socket.id, data);
    });

    // Handle terminal resize
    socket.on('terminal:resize', (size) => {
      if (!isSocketConnected) return;
      this.handleTerminalResize(socket.id, size);
    });

    // Handle disconnect request
    socket.on('terminal:disconnect', () => {
      if (!isSocketConnected) return;
      console.log(`[TERMINAL] User requested disconnect: ${socket.id}`);
      this.handleSSHDisconnect(socket.id, 'manual_disconnect');
    });

    // Handle client disconnect
    socket.on('disconnect', (reason) => {
      isSocketConnected = false;
      console.log(`Terminal client disconnected: ${socket.id}, reason: ${reason}`);
      this.handleSSHDisconnect(socket.id, 'client_disconnect');
    });

    // Handle ping/pong for connection health
    socket.on('ping', () => {
      if (!isSocketConnected) return;
      const session = this.activeSessions.get(socket.id);
      if (session) {
        session.lastActivity = new Date();
      }
      socket.emit('pong'); // Respond to ping
    });

    // Send periodic ping to client for connection health
    const pingInterval = setInterval(() => {
      if (isSocketConnected && socket.connected) {
        socket.emit('ping');
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Every 30 seconds

    // Clean up interval on disconnect
    socket.on('disconnect', () => {
      clearInterval(pingInterval);
    });
  }

  async handleSSHConnect(socket, credentials) {
    const socketId = socket.id;
    
    try {
      // Validate credentials
      const validation = this.validateCredentials(credentials);
      if (!validation.valid) {
        socket.emit('terminal:error', { message: validation.error });
        return;
      }

      // Check if session already exists
      if (this.activeSessions.has(socketId)) {
        console.log(`Cleaning up existing session for ${socketId}`);
        this.handleSSHDisconnect(socketId);
      }

      console.log(`SSH connection attempt: ${credentials.username}@${credentials.host}:${credentials.port}`);

      // Create SSH client
      const conn = new Client();
      const session = {
        conn,
        stream: null,
        credentials: this.sanitizeCredentials(credentials),
        connectedAt: new Date(),
        lastActivity: new Date(),
        socketId: socketId,
        isConnecting: true,
        isConnected: false,
        containerId: credentials.containerId || null
      };

      this.activeSessions.set(socketId, session);

      // Add connection timeout
      const connectionTimeout = setTimeout(() => {
        if (session.isConnecting && !session.isConnected) {
          console.log(`Connection timeout for ${socketId}`);
          socket.emit('terminal:error', { message: 'Connection timeout' });
          this.handleSSHDisconnect(socketId);
        }
      }, 30000); // 30 second timeout

      // Setup SSH connection handlers
      conn.on('ready', () => {
        clearTimeout(connectionTimeout);
        console.log(`SSH connection established for ${socketId}`);
        session.isConnecting = false;
        session.isConnected = true;
        
        // Create shell with proper PTY settings
        conn.shell({ 
          term: 'xterm-256color',
          cols: 80,
          rows: 24,
          width: 640,
          height: 480,
          modes: {
            1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 1,
            11: 0, 30: 0, 31: 1, 32: 0, 33: 1, 34: 1, 35: 0, 36: 1, 37: 0,
            38: 1, 39: 0, 40: 1, 41: 0, 50: 1, 51: 1, 52: 0, 53: 1, 54: 1,
            55: 1, 56: 1, 57: 0, 58: 1, 59: 1, 60: 1, 61: 1, 62: 1, 70: 1,
            71: 0, 72: 1, 73: 0, 74: 0, 75: 0, 90: 19200, 91: 19200
          }
        }, (err, stream) => {
          if (err) {
            console.error('Shell creation error:', err);
            socket.emit('terminal:error', { message: `Shell error: ${err.message}` });
            this.handleSSHDisconnect(socketId);
            return;
          }

          session.stream = stream;
          socket.emit('terminal:connected', { 
            host: credentials.host,
            port: credentials.port,
            username: credentials.username,
            containerId: credentials.containerId || null
          });

          // Handle stream data
          stream.on('data', (data) => {
            try {
              socket.emit('terminal:output', data.toString());
              session.lastActivity = new Date();
              
              // Update container activity if this is a container session
              if (credentials.containerId) {
                const dockerManager = this.containerService.getDockerManager();
                dockerManager.updateContainerActivity(credentials.containerId);
              }
            } catch (error) {
              console.error('Error sending data to client:', error);
              this.handleSSHDisconnect(socketId);
            }
          });

          stream.stderr.on('data', (data) => {
            try {
              socket.emit('terminal:output', data.toString());
              session.lastActivity = new Date();
            } catch (error) {
              console.error('Error sending stderr to client:', error);
              this.handleSSHDisconnect(socketId);
            }
          });

          // Handle stream close
          stream.on('close', (code, signal) => {
            console.log(`SSH stream closed for ${socketId}, code: ${code}, signal: ${signal}`);
            socket.emit('terminal:disconnected', { reason: 'stream_closed' });
            this.handleSSHDisconnect(socketId);
          });

          stream.on('error', (err) => {
            console.error('SSH stream error:', err);
            socket.emit('terminal:error', { message: `Stream error: ${err.message}` });
            this.handleSSHDisconnect(socketId);
          });

          // Set initial terminal size
          try {
            stream.setWindow(24, 80, 480, 640);
          } catch (resizeError) {
            console.warn('Could not set initial window size:', resizeError.message);
          }
        });
      });

      conn.on('error', (err) => {
        clearTimeout(connectionTimeout);
        session.isConnecting = false;
        console.error(`SSH connection error for ${socketId}:`, err);
        let errorMessage = 'Connection failed';
        
        if (err.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused - check host and port';
        } else if (err.code === 'ENOTFOUND') {
          errorMessage = 'Host not found';
        } else if (err.code === 'EHOSTUNREACH') {
          errorMessage = 'Host unreachable';
        } else if (err.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timeout';
        } else if (err.level === 'authentication') {
          errorMessage = 'Authentication failed - check username and password';
        } else if (err.level === 'protocol') {
          errorMessage = 'Protocol error - incompatible SSH server';
        } else {
          errorMessage = err.message || 'Unknown connection error';
        }
        
        socket.emit('terminal:error', { message: errorMessage });
        this.handleSSHDisconnect(socketId);
      });

      conn.on('close', (hadError) => {
        clearTimeout(connectionTimeout);
        session.isConnecting = false;
        session.isConnected = false;
        console.log(`SSH connection closed for ${socketId}, hadError: ${hadError}`);
        socket.emit('terminal:disconnected', { reason: 'connection_closed' });
        this.handleSSHDisconnect(socketId);
      });

      conn.on('end', () => {
        clearTimeout(connectionTimeout);
        session.isConnecting = false;
        session.isConnected = false;
        console.log(`SSH connection ended for ${socketId}`);
        socket.emit('terminal:disconnected', { reason: 'connection_ended' });
        this.handleSSHDisconnect(socketId);
      });

      // Attempt connection
      const connectionOptions = {
        host: credentials.host,
        port: parseInt(credentials.port),
        username: credentials.username,
        readyTimeout: 30000,
        keepaliveInterval: 30000,
        keepaliveCountMax: 3,
        agentForward: false,
        hostVerifier: () => true
      };

      if (credentials.useKeyAuth && credentials.privateKey) {
        connectionOptions.privateKey = credentials.privateKey;
        if (credentials.passphrase) {
          connectionOptions.passphrase = credentials.passphrase;
        }
      } else {
        connectionOptions.password = credentials.password;
      }

      conn.connect(connectionOptions);

    } catch (error) {
      console.error('SSH connection setup error:', error);
      socket.emit('terminal:error', { message: `Setup error: ${error.message}` });
      this.handleSSHDisconnect(socketId);
    }
  }

  handleTerminalInput(socketId, data) {
    const session = this.activeSessions.get(socketId);
    if (session && session.stream && session.stream.writable && session.isConnected) {
      try {
        session.stream.write(data);
        session.lastActivity = new Date();
        
        // Update container activity if this is a container session
        if (session.containerId) {
          const dockerManager = this.containerService.getDockerManager();
          dockerManager.updateContainerActivity(session.containerId);
        }
      } catch (error) {
        console.error('Error writing to stream:', error);
        this.handleSSHDisconnect(socketId);
      }
    }
  }

  handleTerminalResize(socketId, size) {
    const session = this.activeSessions.get(socketId);
    if (session && session.stream && size && size.cols && size.rows && session.isConnected) {
      try {
        session.stream.setWindow(size.rows, size.cols, size.height || 480, size.width || 640);
        console.log(`Terminal resized for ${socketId}: ${size.cols}x${size.rows}`);
      } catch (error) {
        console.error('Error resizing terminal:', error);
      }
    }
  }

  handleSSHDisconnect(socketId, reason = null) {
    const session = this.activeSessions.get(socketId);
    if (session) {
      console.log(`Cleaning up SSH session for ${socketId}, reason: ${reason || 'unknown'}`);
      
      session.isConnecting = false;
      session.isConnected = false;
      
      try {
        if (session.stream && session.stream.writable) {
          session.stream.removeAllListeners();
          session.stream.end();
        }
        if (session.conn) {
          session.conn.removeAllListeners();
          session.conn.end();
        }
      } catch (error) {
        console.error('Error closing SSH connection:', error);
      }
      
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket && reason) {
        socket.emit('terminal:disconnected', { reason });
      }
      
      this.activeSessions.delete(socketId);
      console.log(`SSH session cleaned up for ${socketId}`);
    }
  }

  validateCredentials(credentials) {
    if (!credentials) {
      return { valid: false, error: 'Credentials are required' };
    }
    if (!credentials.host || !credentials.host.trim()) {
      return { valid: false, error: 'Host is required' };
    }
    if (!credentials.port || isNaN(credentials.port) || credentials.port < 1 || credentials.port > 65535) {
      return { valid: false, error: 'Valid port number (1-65535) is required' };
    }
    if (!credentials.username || !credentials.username.trim()) {
      return { valid: false, error: 'Username is required' };
    }
    if (credentials.useKeyAuth) {
      if (!credentials.privateKey || !credentials.privateKey.trim()) {
        return { valid: false, error: 'Private key is required for key authentication' };
      }
    } else {
      if (!credentials.password || !credentials.password.trim()) {
        return { valid: false, error: 'Password is required' };
      }
    }
    return { valid: true };
  }

  sanitizeCredentials(credentials) {
    return {
      host: credentials.host,
      port: credentials.port,
      username: credentials.username,
      useKeyAuth: credentials.useKeyAuth || false,
      containerId: credentials.containerId || null
    };
  }

  getSessionStats() {
    const now = new Date();
    const stats = {
      totalSessions: this.activeSessions.size,
      sessions: []
    };

    for (const [socketId, session] of this.activeSessions) {
      const duration = now - session.connectedAt;
      const idleTime = now - session.lastActivity;
      
      stats.sessions.push({
        socketId,
        host: session.credentials.host,
        port: session.credentials.port,
        username: session.credentials.username,
        connectedAt: session.connectedAt,
        duration: Math.floor(duration / 1000),
        idleTime: Math.floor(idleTime / 1000),
        isActive: idleTime < 300000,
        isConnecting: session.isConnecting,
        isConnected: session.isConnected,
        containerId: session.containerId
      });
    }

    return stats;
  }

  cleanupIdleSessions(maxIdleTime = 30 * 60 * 1000) {
    const now = new Date();
    const sessionsToCleanup = [];

    for (const [socketId, session] of this.activeSessions) {
      const idleTime = now - session.lastActivity;
      if (idleTime > maxIdleTime) {
        sessionsToCleanup.push(socketId);
      }
    }

    sessionsToCleanup.forEach(socketId => {
      console.log(`Cleaning up idle session: ${socketId}`);
      this.handleSSHDisconnect(socketId, 'idle_timeout');
      
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('terminal:disconnected', { reason: 'idle_timeout' });
      }
    });

    return sessionsToCleanup.length;
  }

  startHealthMonitoring() {
    this.healthInterval = Meteor.setInterval(() => {
      this.checkConnectionHealth();
    }, 60000);
  }

  checkConnectionHealth() {
    const now = new Date();
    const staleConnections = [];
    
    for (const [socketId, session] of this.activeSessions) {
      const socket = this.io.sockets.sockets.get(socketId);
      
      if (!socket || !socket.connected) {
        console.log(`Removing stale session: ${socketId} (socket disconnected)`);
        staleConnections.push(socketId);
        continue;
      }
      
      if (session.isConnecting && (now - session.connectedAt) > 60000) {
        console.log(`Removing stuck connecting session: ${socketId}`);
        socket.emit('terminal:error', { message: 'Connection timed out' });
        staleConnections.push(socketId);
        continue;
      }
      
      const inactiveTime = now - session.lastActivity;
      if (inactiveTime > 30 * 60 * 1000) {
        console.log(`Removing inactive session: ${socketId}`);
        socket.emit('terminal:disconnected', { reason: 'inactive' });
        staleConnections.push(socketId);
      }
    }
    
    staleConnections.forEach(socketId => {
      this.handleSSHDisconnect(socketId, 'health_check_cleanup');
    });
  }

  forceDisconnect(socketId) {
    const session = this.activeSessions.get(socketId);
    if (session) {
      console.log(`Force disconnecting session: ${socketId}`);
      this.handleSSHDisconnect(socketId, 'force_disconnect');
      
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('terminal:disconnected', { reason: 'force_disconnect' });
        socket.disconnect(true);
      }
      
      return true;
    }
    return false;
  }

  getSession(socketId) {
    return this.activeSessions.get(socketId);
  }

  getAllSessions() {
    return Array.from(this.activeSessions.values());
  }

  getContainerService() {
    return this.containerService;
  }

  shutdown() {
    console.log('Shutting down terminal server...');
    
    if (this.cleanupInterval) {
      Meteor.clearInterval(this.cleanupInterval);
    }
    if (this.healthInterval) {
      Meteor.clearInterval(this.healthInterval);
    }
    
    const disconnectPromises = [];
    for (const [socketId, session] of this.activeSessions) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('terminal:disconnected', { reason: 'server_shutdown' });
      }
      
      disconnectPromises.push(
        new Promise(resolve => {
          this.handleSSHDisconnect(socketId, 'server_shutdown');
          resolve();
        })
      );
    }
    
    Promise.all(disconnectPromises).then(async () => {
      // Shutdown container service
      if (this.containerService) {
        await this.containerService.shutdown();
      }
      
      if (this.io) {
        this.io.close();
      }
      console.log('Terminal server shutdown complete');
    });
  }
}

// Export singleton instance
let terminalServerInstance = null;

export const getTerminalServer = () => {
  if (!terminalServerInstance) {
    terminalServerInstance = new TerminalServer();
  }
  return terminalServerInstance;
};

// Enhanced API endpoints with container integration

// Combined terminal and container statistics
WebApp.connectHandlers.use('/api/terminal-stats', (req, res) => {
  try {
    const server = getTerminalServer();
    const terminalStats = server.getSessionStats();
    const containerStats = server.getContainerService().getServiceStats();
    
    const combinedStats = {
      terminal: terminalStats,
      containers: containerStats,
      timestamp: new Date().toISOString()
    };
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(combinedStats));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

// Force disconnect session (now with container cleanup)
WebApp.connectHandlers.use('/api/terminal-disconnect', (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { socketId } = JSON.parse(body);
        const server = getTerminalServer();
        
        // Get session info before disconnecting
        const session = server.getSession(socketId);
        const containerId = session?.containerId;
        
        // Force disconnect the terminal session
        const success = server.forceDisconnect(socketId);
        
        // If there was a container, stop it too
        let containerStopped = false;
        if (containerId) {
          try {
            const dockerManager = server.getContainerService().getDockerManager();
            await dockerManager.stopContainer(containerId);
            containerStopped = true;
          } catch (containerError) {
            console.error('Error stopping container during force disconnect:', containerError);
          }
        }
        
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ 
          success, 
          message: success ? 'Session disconnected' : 'Session not found',
          containerStopped
        }));
      } catch (parseError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

// Enhanced health check with container service status
WebApp.connectHandlers.use('/api/terminal-health', async (req, res) => {
  try {
    const server = getTerminalServer();
    const containerService = server.getContainerService();
    const dockerManager = containerService.getDockerManager();
    
    // Check Docker availability
    const dockerAvailable = await dockerManager.checkDockerAvailability();
    
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      activeSessions: server.activeSessions.size,
      containerService: {
        status: 'integrated',
        activeContainers: dockerManager.activeContainers.size,
        dockerAvailable
      },
      timestamp: new Date().toISOString()
    };
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(health));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    }));
  }
});

// Initialize on server startup
Meteor.startup(() => {
  getTerminalServer();
  console.log('Terminal server started with integrated container service');
  
  // Check Docker availability on startup
  const server = getTerminalServer();
  const dockerManager = server.getContainerService().getDockerManager();
  
  dockerManager.checkDockerAvailability()
    .then(available => {
      if (available) {
        console.log('[STARTUP] Docker is available - container functionality enabled');
      } else {
        console.warn('[STARTUP] Docker is not available - container functionality disabled');
      }
    })
    .catch(error => {
      console.warn('[STARTUP] Error checking Docker availability:', error.message);
    });
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down terminal server...');
    const server = getTerminalServer();
    server.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down terminal server...');
    const server = getTerminalServer();
    server.shutdown();
    process.exit(0);
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    const server = getTerminalServer();
    server.shutdown();
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
});