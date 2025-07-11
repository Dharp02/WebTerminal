// server/main.js
import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { Server } from 'socket.io';
import { Client } from 'ssh2';
import { getDockerManager } from './dockermanager.js';

// Terminal server class for handling SSH connections
export class TerminalServer {
  constructor() {
    this.activeSessions = new Map();
    this.io = null;
    this.cleanupInterval = null;
    this.healthInterval = null;
    this.dockerManager = getDockerManager();
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

    console.log('Terminal server initialized with health monitoring and Docker support');
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
        console.log(`[TERMINAL] Creating container for client: ${socket.id}`);
        socket.emit('terminal:container-creating', { message: 'Creating your container...' });
        
        const containerInfo = await this.dockerManager.createSSHContainer();
        
        // Automatically connect to the new container
        const credentials = {
          host: containerInfo.host,
          port: containerInfo.port,
          username: containerInfo.username,
          password: containerInfo.password,
          containerId: containerInfo.containerId
        };
        
        socket.emit('terminal:container-created', containerInfo);
        
        // Wait a moment for the container to be fully ready, then connect
        setTimeout(() => {
          if (isSocketConnected) {
            this.handleSSHConnect(socket, credentials);
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
      this.handleSSHDisconnect(socket.id);
    });

    // Handle client disconnect
    socket.on('disconnect', (reason) => {
      isSocketConnected = false;
      console.log(`Terminal client disconnected: ${socket.id}, reason: ${reason}`);
      this.handleSSHDisconnect(socket.id);
    });

    // Handle ping/pong for connection health
    socket.on('ping', () => {
      if (!isSocketConnected) return;
      const session = this.activeSessions.get(socket.id);
      if (session) {
        session.lastActivity = new Date();
        // Update container activity if it's a container session
        if (session.containerId) {
          this.dockerManager.updateContainerActivity(session.containerId);
        }
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
        containerId: credentials.containerId || null // Track if this is a container session
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
            // TTY modes for proper terminal behavior
            1: 0,     // VEOF
            2: 0,     // VEOL
            3: 0,     // VERASE
            4: 0,     // VINTR
            5: 0,     // VKILL
            6: 0,     // VQUIT
            7: 0,     // VSUSP
            8: 0,     // VSTART
            9: 0,     // VSTOP
            10: 1,    // VMIN
            11: 0,    // VTIME
            30: 0,    // IGNPAR
            31: 1,    // PARMRK
            32: 0,    // INPCK
            33: 1,    // ISTRIP
            34: 1,    // INLCR
            35: 0,    // IGNCR
            36: 1,    // ICRNL
            37: 0,    // IUCLC
            38: 1,    // IXON
            39: 0,    // IXANY
            40: 1,    // IXOFF
            41: 0,    // IMAXBEL
            50: 1,    // ISIG
            51: 1,    // ICANON
            52: 0,    // XCASE
            53: 1,    // ECHO
            54: 1,    // ECHOE
            55: 1,    // ECHOK
            56: 1,    // ECHONL
            57: 0,    // NOFLSH
            58: 1,    // TOSTOP
            59: 1,    // IEXTEN
            60: 1,    // ECHOCTL
            61: 1,    // ECHOKE
            62: 1,    // PENDIN
            70: 1,    // OPOST
            71: 0,    // OLCUC
            72: 1,    // ONLCR
            73: 0,    // OCRNL
            74: 0,    // ONOCR
            75: 0,    // ONLRET
            90: 19200, // CS7
            91: 19200  // CS8
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

          // Handle stream data with error checking
          stream.on('data', (data) => {
            try {
              socket.emit('terminal:output', data.toString());
              session.lastActivity = new Date();
              // Update container activity if it's a container session
              if (session.containerId) {
                this.dockerManager.updateContainerActivity(session.containerId);
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
              // Update container activity if it's a container session
              if (session.containerId) {
                this.dockerManager.updateContainerActivity(session.containerId);
              }
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
        // Update container activity if it's a container session
        if (session.containerId) {
          this.dockerManager.updateContainerActivity(session.containerId);
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

  handleSSHDisconnect(socketId) {
    const session = this.activeSessions.get(socketId);
    if (session) {
      console.log(`Cleaning up SSH session for ${socketId}`);
      
      // Mark as disconnecting to prevent new operations
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

  // Get active session statistics
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
        duration: Math.floor(duration / 1000), // seconds
        idleTime: Math.floor(idleTime / 1000), // seconds
        isActive: idleTime < 300000, // 5 minutes
        isConnecting: session.isConnecting,
        isConnected: session.isConnected,
        containerId: session.containerId
      });
    }

    return stats;
  }

  // Cleanup idle sessions
  cleanupIdleSessions(maxIdleTime = 30 * 60 * 1000) { // 30 minutes default
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
      
      // Notify client of disconnection
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('terminal:disconnected', { reason: 'idle_timeout' });
      }
    });

    return sessionsToCleanup.length;
  }

  // Add connection health monitoring
  startHealthMonitoring() {
    // Monitor connection health every 60 seconds
    this.healthInterval = Meteor.setInterval(() => {
      this.checkConnectionHealth();
    }, 60000);
  }

  checkConnectionHealth() {
    const now = new Date();
    const staleConnections = [];
    
    for (const [socketId, session] of this.activeSessions) {
      const socket = this.io.sockets.sockets.get(socketId);
      
      // Check if socket still exists and is connected
      if (!socket || !socket.connected) {
        console.log(`Removing stale session: ${socketId} (socket disconnected)`);
        staleConnections.push(socketId);
        continue;
      }
      
      // Check for stuck connecting state
      if (session.isConnecting && (now - session.connectedAt) > 60000) { // 1 minute
        console.log(`Removing stuck connecting session: ${socketId}`);
        socket.emit('terminal:error', { message: 'Connection timed out' });
        staleConnections.push(socketId);
        continue;
      }
      
      // Check for inactive connections
      const inactiveTime = now - session.lastActivity;
      if (inactiveTime > 30 * 60 * 1000) { // 30 minutes
        console.log(`Removing inactive session: ${socketId}`);
        socket.emit('terminal:disconnected', { reason: 'inactive' });
        staleConnections.push(socketId);
      }
    }
    
    // Clean up stale connections
    staleConnections.forEach(socketId => {
      this.handleSSHDisconnect(socketId);
    });
  }

  // Force disconnect a session
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

  // Get session by socket ID
  getSession(socketId) {
    return this.activeSessions.get(socketId);
  }

  // Get all active sessions
  getAllSessions() {
    return Array.from(this.activeSessions.values());
  }

  // Updated shutdown method
  shutdown() {
    console.log('Shutting down terminal server...');
    
    // Clear intervals
    if (this.cleanupInterval) {
      Meteor.clearInterval(this.cleanupInterval);
    }
    if (this.healthInterval) {
      Meteor.clearInterval(this.healthInterval);
    }
    
    // Shutdown Docker manager
    this.dockerManager.shutdown();
    
    // Close all active sessions gracefully
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
    
    // Wait for all disconnections to complete
    Promise.all(disconnectPromises).then(() => {
      // Close Socket.IO server
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

// API endpoint for Docker container statistics
WebApp.connectHandlers.use('/api/container-stats', (req, res) => {
  try {
    const dockerManager = getDockerManager();
    const stats = dockerManager.getContainerStats();
    
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

// API endpoint to create a new container
WebApp.connectHandlers.use('/api/create', (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight request
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    console.log('[API] Container creation request received');
    
    const dockerManager = getDockerManager();
    
    // Check Docker availability first
    dockerManager.checkDockerAvailability().then(isAvailable => {
      if (!isAvailable) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Docker is not available on this system' 
        }));
        return;
      }

      // Create container
      dockerManager.createSSHContainer().then(containerInfo => {
        console.log('[API] Container created successfully:', containerInfo);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          container: containerInfo,
          message: 'Container created successfully'
        }));
      }).catch(error => {
        console.error('[API] Container creation failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          error: error.message 
        }));
      });
    }).catch(error => {
      console.error('[API] Docker availability check failed:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        error: 'Failed to check Docker availability' 
      }));
    });
    
  } catch (error) {
    console.error('[API] Unexpected error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: false, 
      error: 'Internal server error' 
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

// API endpoint to stop a container
WebApp.connectHandlers.use('/api/container-stop', (req, res) => {
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
        const { containerId } = JSON.parse(body);
        const dockerManager = getDockerManager();
        
        dockerManager.stopContainer(containerId).then(() => {
          res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Container stopped successfully' 
          }));
        }).catch(error => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false, 
            error: error.message 
          }));
        });
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
WebApp.connectHandlers.use('/api/terminal-health', (req, res) => {
  try {
    const server = getTerminalServer();
    const dockerManager = getDockerManager();
    
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      activeSessions: server.activeSessions.size,
      activeContainers: dockerManager.activeContainers.size,
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
  console.log('Terminal server started with Docker container support');
  
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