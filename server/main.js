// server/main.js
import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { Server } from 'socket.io';
import { Client } from 'ssh2';

import fetch from 'node-fetch';
// Container service configuration
// At the top of server/main.js
const CONTAINER_SERVICE_URL = process.env.CONTAINER_SERVICE_URL || 'http://localhost:3001';

// Terminal server class for handling SSH connections
export class TerminalServer {
  constructor() {
    this.activeSessions = new Map();
    this.io = null;
    this.cleanupInterval = null;
    this.healthInterval = null;
    this.initialize();
  }

  initialize() {
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

    console.log('Terminal server initialized with Express container service integration');
  }

  // Call container service API
  async callContainerService(endpoint, options = {}) {
    try {
      const url = `${CONTAINER_SERVICE_URL}${endpoint}`;
      console.log(`[CONTAINER_SERVICE] Calling: ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });

      if (!response.ok) {
        throw new Error(`Container service error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[CONTAINER_SERVICE] Error:', error.message);
      throw new Error(`Container service unavailable: ${error.message}`);
    }
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

    // Handle container creation request
    socket.on('terminal:create-container', async () => {
      if (!isSocketConnected) return;
      
      try {
        console.log(`[TERMINAL] Requesting container from service for: ${socket.id}`);
        socket.emit('terminal:container-creating', { message: 'Creating your container...' });
        
        // Call Express container service
        const data = await this.callContainerService('/api/containers/create', {
          method: 'POST'
        });
        
        if (!data.success) {
          throw new Error(data.error || 'Container creation failed');
        }
        
        const containerInfo = data.container;
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
      this.handleSSHDisconnect(socket.id, 'user_disconnect');
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
      this.handleSSHDisconnect(socketId);
      
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
      this.handleSSHDisconnect(socketId);
    });
  }

  forceDisconnect(socketId) {
    const session = this.activeSessions.get(socketId);
    if (session) {
      console.log(`Force disconnecting session: ${socketId}`);
      this.handleSSHDisconnect(socketId);
      
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
          this.handleSSHDisconnect(socketId);
          resolve();
        })
      );
    }
    
    Promise.all(disconnectPromises).then(() => {
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

// API endpoint for session statistics
WebApp.connectHandlers.use('/api/terminal-stats', (req, res) => {
  try {
    const server = getTerminalServer();
    const stats = server.getSessionStats();
    
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

// API endpoint for container statistics (proxy to container service)
WebApp.connectHandlers.use('/api/container-stats', async (req, res) => {
  try {
    const response = await fetch(`${CONTAINER_SERVICE_URL}/api/containers/list`);
    const data = await response.json();
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Container service error: ${error.message}` }));
  }
});

// API endpoint to create container (proxy to container service)
WebApp.connectHandlers.use('/api/create', async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    console.log('[API] Container creation request received, forwarding to container service');
    
    const response = await fetch(`${CONTAINER_SERVICE_URL}/api/containers/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Container service error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    
  } catch (error) {
    console.error('[API] Container creation failed:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: false, 
      error: `Container service unavailable: ${error.message}` 
    }));
  }
});

// API endpoint to force disconnect a session
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

    req.on('end', () => {
      try {
        const { socketId } = JSON.parse(body);
        const server = getTerminalServer();
        const success = server.forceDisconnect(socketId);
        
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success, message: success ? 'Session disconnected' : 'Session not found' }));
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

// API endpoint to stop container (proxy to container service)
WebApp.connectHandlers.use('/api/container-stop', async (req, res) => {
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
        const { containerId } = JSON.parse(body);
        
        const response = await fetch(`${CONTAINER_SERVICE_URL}/api/containers/${containerId}`, {
          method: 'DELETE'
        });

        const data = await response.json();
        
        res.writeHead(response.ok ? 200 : 500, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(data));
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

// API endpoint to get session details
WebApp.connectHandlers.use('/api/terminal-session', (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const socketId = url.searchParams.get('socketId');
    
    if (!socketId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'socketId parameter required' }));
      return;
    }

    const server = getTerminalServer();
    const session = server.getSession(socketId);
    
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const sessionInfo = {
      socketId: session.socketId,
      credentials: session.credentials,
      connectedAt: session.connectedAt,
      lastActivity: session.lastActivity,
      duration: Date.now() - session.connectedAt.getTime(),
      isConnecting: session.isConnecting,
      isConnected: session.isConnected,
      containerId: session.containerId
    };
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(sessionInfo));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

// API endpoint for health check
WebApp.connectHandlers.use('/api/terminal-health', async (req, res) => {
  try {
    const server = getTerminalServer();
    
    let containerServiceHealth = 'unknown';
    let containerCount = 0;
    
    try {
      const containerResponse = await fetch(`${CONTAINER_SERVICE_URL}/health`);
      if (containerResponse.ok) {
        containerServiceHealth = 'healthy';
        
        const statsResponse = await fetch(`${CONTAINER_SERVICE_URL}/api/containers/list`);
        if (statsResponse.ok) {
          const statsData = await statsResponse.json();
          containerCount = statsData.containers ? statsData.containers.length : 0;
        }
      } else {
        containerServiceHealth = 'unhealthy';
      }
    } catch (error) {
      containerServiceHealth = 'unavailable';
    }
    
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      activeSessions: server.activeSessions.size,
      containerService: {
        status: containerServiceHealth,
        url: CONTAINER_SERVICE_URL,
        activeContainers: containerCount
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
  console.log('Terminal server started with Express container service integration');
  console.log(`Container service URL: ${CONTAINER_SERVICE_URL}`);
  
  // Check container service availability on startup
  fetch(`${CONTAINER_SERVICE_URL}/health`)
    .then(response => {
      if (response.ok) {
        console.log('[STARTUP] Container service is available');
      } else {
        console.warn('[STARTUP] Container service is not responding properly');
      }
    })
    .catch(error => {
      console.warn('[STARTUP] Container service is not available:', error.message);
      console.warn('[STARTUP] Container functionality will be limited');
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