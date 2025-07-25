// imports/ui/TerminalComponent.jsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import io from 'socket.io-client';
import 'xterm/css/xterm.css';

// Original TerminalComponent with Session Persistence - No Manual Container Creation
const TerminalComponent = ({ 
  show = true, 
  host = 'localhost', 
  username = 'root', 
  password = '', 
  port = 22,
  isConnected: externalIsConnected = false,
  onConnect = null,
  onDisconnect = null,
  onStatusChange = null,
  className = '',
  style = {},
  autoConnect = false,
  theme = 'dark',
  useKeyAuth = false,
  privateKey = '',
  passphrase = '',
  maintainSession = false
}) => {
  const terminalRef = useRef(null);
  const term = useRef(null);
  const fitAddon = useRef(new FitAddon());
  const socket = useRef(null);
  const resizeObserver = useRef(null);
  const autoConnectAttempted = useRef(false);
  const reconnectTimeout = useRef(null);
  const componentMounted = useRef(true);
  const initializationComplete = useRef(false);
  const sessionActive = useRef(false);
  
  const [isConnected, setIsConnected] = useState(externalIsConnected);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [isConnecting, setIsConnecting] = useState(false);
  const [sessionHistory, setSessionHistory] = useState([]);
  const [connectionError, setConnectionError] = useState(null);
  const [containerInfo, setContainerInfo] = useState(null);
  const [isCreatingContainer, setIsCreatingContainer] = useState(false);
  const [useContainer, setUseContainer] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false); // NEW: Track if session was ended

  // Terminal themes
  const themes = {
    dark: {
      background: '#1e1e1e',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selection: '#4d4d4d',
      black: '#000000',
      red: '#e74c3c',
      green: '#2ecc71',
      yellow: '#f1c40f',
      blue: '#3498db',
      magenta: '#9b59b6',
      cyan: '#1abc9c',
      white: '#ecf0f1'
    },
    light: {
      background: '#ffffff',
      foreground: '#2c3e50',
      cursor: '#2c3e50',
      selection: '#d5dbdb',
      black: '#2c3e50',
      red: '#e74c3c',
      green: '#27ae60',
      yellow: '#f39c12',
      blue: '#2980b9',
      magenta: '#8e44ad',
      cyan: '#16a085',
      white: '#ecf0f1'
    }
  };

  // Clear any reconnect timeouts
  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
  }, []);

  // Handle local input when not connected
  const handleLocalInput = useCallback((data) => {
    if (!term.current || !componentMounted.current) return;

    if (data === '\r') {
      term.current.write('\r\n');
    } else if (data === '\u007F') {
      term.current.write('\b \b');
    } else if (data === '\u0003') {
      term.current.write('^C\r\n');
    } else if (data.charCodeAt(0) < 32) {
      const char = String.fromCharCode(data.charCodeAt(0) + 64);
      term.current.write(`^${char}`);
    } else {
      term.current.write(data);
    }
  }, []);

  // Setup resize observer
  const setupResizeObserver = useCallback(() => {
    if (resizeObserver.current) {
      resizeObserver.current.disconnect();
    }
    
    resizeObserver.current = new ResizeObserver(() => {
      if (fitAddon.current && terminalRef.current?.offsetWidth > 0 && componentMounted.current) {
        try {
          fitAddon.current.fit();
          
          if (socket.current && socket.current.connected && term.current) {
            const cols = term.current.cols;
            const rows = term.current.rows;
            socket.current.emit('terminal:resize', { cols, rows });
          }
        } catch (error) {
          console.warn('Resize error:', error);
        }
      }
    });
    
    if (terminalRef.current) {
      resizeObserver.current.observe(terminalRef.current);
    }
  }, []);

  // Check if should use container (when fields are empty AND session not ended)
  const shouldUseContainer = useCallback(() => {
    if (sessionEnded) {
      return false; // Don't create containers if session was ended
    }
    return !host.trim() || host === 'localhost' && !username.trim() && !password.trim();
  }, [host, username, password, sessionEnded]);

  // Initialize terminal
  const initializeTerminal = useCallback(() => {
    if (!terminalRef.current || !componentMounted.current || initializationComplete.current || !show) {
      return;
    }

    console.log('[TERMINAL] Initializing terminal');

    term.current = new Terminal({
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", "Lucida Console", monospace',
      cursorBlink: true,
      theme: themes[theme] || themes.dark,
      scrollback: 5000,
      convertEol: true,
      allowTransparency: false,
      rows: 24,
      cols: 80,
      rightClickSelectsWord: true,
      macOptionIsMeta: true,
      altClickMovesCursor: false
    });

    term.current.loadAddon(fitAddon.current);
    term.current.open(terminalRef.current);

    term.current.writeln('\x1b[36m╭─────────────────────────────────────╮\x1b[0m');
    term.current.writeln('\x1b[36m│        SSH Terminal Component        │\x1b[0m');
    term.current.writeln('\x1b[36m╰─────────────────────────────────────╯\x1b[0m');
    term.current.writeln('\x1b[32mReady to connect...\x1b[0m');
    term.current.writeln('\x1b[90mPress Ctrl+C to interrupt, type "exit" to disconnect\x1b[0m\r\n');

    term.current.onData(data => {
      if (socket.current && socket.current.connected) {
        socket.current.emit('terminal:input', data);
        setSessionHistory(prev => [...prev.slice(-100), { 
          type: 'input', 
          data, 
          timestamp: Date.now() 
        }]);
      } else {
        handleLocalInput(data);
      }
    });

    term.current.onSelectionChange(() => {
      const selection = term.current.getSelection();
      if (selection) {
        navigator.clipboard?.writeText(selection).catch(() => {
          console.log('Could not copy to clipboard');
        });
      }
    });

    setTimeout(() => {
      if (fitAddon.current && componentMounted.current && show) {
        try {
          fitAddon.current.fit();
        } catch (error) {
          console.warn('Initial fit error:', error);
        }
      }
      if (term.current && componentMounted.current && show) {
        term.current.focus();
      }
    }, 100);

    initializationComplete.current = true;
    console.log('[TERMINAL] Terminal initialized successfully');
  }, [theme, handleLocalInput, show]);

  // Setup socket connection - PERSISTENT (not affected by show/hide)
  const setupSocketConnection = useCallback(() => {
    if (!componentMounted.current || socket.current) {
      return;
    }

    console.log('[TERMINAL] Setting up persistent socket connection');

    socket.current = io(window.location.origin, {
      forceNew: true,
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnection: false
    });

    socket.current.on('connect', () => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Socket connected to server');
      if (term.current && show) {
        term.current.writeln('\r\n\x1b[32m✓ Connected to server\x1b[0m');
      }
    });

    socket.current.on('connect_error', (error) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Socket connection error:', error.message);
      setConnectionError(`Server connection failed: ${error.message}`);
      if (term.current && show) {
        term.current.writeln(`\r\n\x1b[31m✗ Server connection failed: ${error.message}\x1b[0m`);
      }
    });

    socket.current.on('disconnect', (reason) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Socket disconnected:', reason);
      setIsConnected(false);
      setConnectionStatus('Disconnected');
      setIsConnecting(false);
      setIsCreatingContainer(false);
      clearReconnectTimeout();
      sessionActive.current = false;
      onStatusChange?.('disconnected');
      onDisconnect?.();
      
      if (term.current && show) {
        term.current.writeln(`\r\n\x1b[31m✗ Disconnected from server (${reason})\x1b[0m`);
      }
    });

    // Container creation events
    socket.current.on('terminal:container-creating', (data) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Container creation started');
      setIsCreatingContainer(true);
      setConnectionStatus('Creating container...');
      if (term.current && show) {
        term.current.writeln('\r\n\x1b[33m→ Creating your container...\x1b[0m');
      }
    });

    socket.current.on('terminal:container-created', (data) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Container created:', data);
      setContainerInfo(data);
      setIsCreatingContainer(false);
      setConnectionStatus('Container ready');
      if (term.current && show) {
        term.current.writeln(`\r\n\x1b[32m✓ Container created successfully!\x1b[0m`);
        term.current.writeln(`\x1b[90mContainer ID: ${data.containerId}\x1b[0m`);
        term.current.writeln(`\x1b[90mSSH Port: ${data.port}\x1b[0m`);
        term.current.writeln('\x1b[33m→ Connecting to container...\x1b[0m');
      }
    });

    socket.current.on('terminal:output', data => {
      if (!componentMounted.current) return;
      if (term.current && show) {
        term.current.write(data);
      } else if (term.current && !show) {
        term.current.write(data);
      }
      setSessionHistory(prev => [...prev.slice(-100), { 
        type: 'output', 
        data, 
        timestamp: Date.now() 
      }]);
    });

    socket.current.on('terminal:connected', (data) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] SSH Connected successfully:', data);
      setConnectionStatus('SSH Connected');
      setIsConnected(true);
      setIsConnecting(false);
      setIsCreatingContainer(false);
      setConnectionError(null);
      sessionActive.current = true;
      clearReconnectTimeout();
      onStatusChange?.('connected');
      onConnect?.();
      
      if (term.current && show) {
        if (data.containerId) {
          term.current.writeln('\r\n\x1b[32m✓ Connected to your container!\x1b[0m');
          term.current.writeln(`\x1b[90mContainer: ${data.containerId}\x1b[0m`);
        } else {
          term.current.writeln('\r\n\x1b[32m✓ SSH Connection established\x1b[0m');
        }
        term.current.writeln(`\x1b[90mConnected to ${data.username}@${data.host}:${data.port}\x1b[0m\r\n`);
      }
    });

    socket.current.on('terminal:error', (error) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] SSH Error:', error.message);
      setIsConnecting(false);
      setIsCreatingContainer(false);
      setConnectionStatus('Error');
      setConnectionError(error.message);
      clearReconnectTimeout();
      onStatusChange?.('error');
      
      if (term.current && show) {
        term.current.writeln(`\r\n\x1b[31m✗ SSH Error: ${error.message}\x1b[0m\r\n`);
      }
    });

    socket.current.on('terminal:disconnected', (data) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] SSH Disconnected:', data);
      setIsConnected(false);
      setConnectionStatus('Disconnected');
      setIsConnecting(false);
      setIsCreatingContainer(false);
      sessionActive.current = false;
      clearReconnectTimeout();
      onStatusChange?.('disconnected');
      onDisconnect?.();
      
      // Don't auto-reconnect on manual disconnect
      if (data?.reason === 'manual_disconnect') {
        autoConnectAttempted.current = true; // Prevent auto-reconnect
      }
      
      if (term.current && show) {
        const reason = data?.reason ? ` (${data.reason})` : '';
        term.current.writeln(`\r\n\x1b[33m✗ SSH session ended${reason}\x1b[0m\r\n`);
      }
    });

    console.log('[TERMINAL] Socket event handlers set up');
  }, [onConnect, onDisconnect, onStatusChange, clearReconnectTimeout, show]);

  // Create container (automatically called, no manual button)
  const createContainer = useCallback(() => {
    if (!componentMounted.current || !socket.current || isCreatingContainer || isConnected) {
      return;
    }

    console.log('[TERMINAL] Auto-creating container for empty connection fields');
    setConnectionError(null);
    setUseContainer(true);
    
    if (term.current && show) {
      term.current.writeln('\r\n\x1b[33m→ Requesting new container...\x1b[0m');
    }

    socket.current.emit('terminal:create-container');
  }, [isCreatingContainer, isConnected, show]);

  // Connect to SSH - Updated to automatically handle container creation
  const connectSSH = useCallback(() => {
    if (!componentMounted.current || !socket.current || isConnecting || isConnected) {
      return;
    }

    console.log('[TERMINAL] Starting connection process');
    setConnectionError(null);

    // Check if session was ended - prevent container creation
    if (sessionEnded && shouldUseContainer()) {
      const errorMsg = 'Container session was ended. Please restart the server to create new containers.';
      setConnectionError(errorMsg);
      if (term.current && show) {
        term.current.writeln('\r\n\x1b[31m✗ Container session was ended\x1b[0m');
        term.current.writeln('\x1b[90mPlease restart the server to create new containers.\x1b[0m\r\n');
      }
      return;
    }

    // Check if we should use container mode (empty/default fields)
    if (shouldUseContainer() && !containerInfo) {
      // Automatically create container without user interaction
      console.log('[TERMINAL] Empty connection fields detected - auto-creating container');
      createContainer();
      return;
    }

    // Use existing container info or provided credentials
    const credentials = containerInfo ? {
      host: containerInfo.host,
      port: containerInfo.port,
      username: containerInfo.username,
      password: containerInfo.password,
      containerId: containerInfo.containerId
    } : {
      host,
      port: parseInt(port),
      username,
      useKeyAuth
    };

    if (!containerInfo) {
      if (useKeyAuth) {
        credentials.privateKey = privateKey;
        if (passphrase) {
          credentials.passphrase = passphrase;
        }
      } else {
        credentials.password = password;
      }
    }

    // Validate inputs for direct SSH connections
    if (!containerInfo && (!credentials.host?.trim() || !credentials.username?.trim() || 
        (!credentials.password?.trim() && !credentials.useKeyAuth))) {
      const errorMsg = 'Missing required connection parameters';
      setConnectionError(errorMsg);
      if (term.current && show) {
        term.current.writeln('\r\n\x1b[31m✗ Missing required connection parameters\x1b[0m');
      }
      return;
    }

    setIsConnecting(true);
    setConnectionStatus('Connecting...');
    clearReconnectTimeout();
    
    if (term.current && show) {
      if (containerInfo) {
        term.current.writeln(`\r\n\x1b[33m→ Connecting to container ${containerInfo.containerId}...\x1b[0m`);
      } else {
        term.current.writeln(`\r\n\x1b[33m→ Connecting to ${credentials.username}@${credentials.host}:${credentials.port}...\x1b[0m`);
      }
    }

    socket.current.emit('terminal:connect', credentials);
  }, [host, username, password, port, useKeyAuth, privateKey, passphrase, 
      isConnecting, isConnected, clearReconnectTimeout, containerInfo, 
      shouldUseContainer, createContainer, show, sessionEnded]);

  // Disconnect from SSH - EXPLICIT disconnect only (keeps container alive)
  const disconnectSSH = useCallback(() => {
    if (!componentMounted.current) return;
    
    console.log('[TERMINAL] EXPLICIT disconnect requested (container preserved)');
    clearReconnectTimeout();
    autoConnectAttempted.current = false;
    sessionActive.current = false;
    
    // Set a flag to prevent auto-reconnection
    const wasAutoConnect = autoConnect;
    
    // DON'T clear containerInfo - keep it for manual reconnection
    setIsConnecting(false);
    setIsConnected(false);
    setConnectionStatus('Disconnected');
    
    if (socket.current) {
      socket.current.emit('terminal:disconnect');
    }
    
    if (term.current && show) {
      term.current.writeln('\r\n\x1b[33m✓ Disconnected (container preserved)\x1b[0m');
      if (containerInfo) {
        term.current.writeln('\x1b[90mUse Reconnect to return to your container, or End Session to destroy it.\x1b[0m\r\n');
      }
    }
  }, [clearReconnectTimeout, containerInfo, show]);

  // Reconnect to existing container
  const reconnectSSH = useCallback(() => {
    if (!componentMounted.current || !containerInfo) return;
    
    console.log('[TERMINAL] Reconnecting to existing container:', containerInfo.containerId);
    setConnectionError(null);
    
    // Reset auto-connect flag for this manual reconnection
    autoConnectAttempted.current = false;
    
    if (term.current && show) {
      term.current.writeln(`\r\n\x1b[33m→ Reconnecting to container ${containerInfo.containerId}...\x1b[0m`);
    }
    
    // Use existing container credentials
    const credentials = {
      host: containerInfo.host,
      port: containerInfo.port,
      username: containerInfo.username,
      password: containerInfo.password,
      containerId: containerInfo.containerId
    };
    
    setIsConnecting(true);
    setConnectionStatus('Reconnecting...');
    
    socket.current.emit('terminal:connect', credentials);
  }, [containerInfo, show]);

  // End session permanently (destroys container)
  const endSession = useCallback(async () => {
    if (!componentMounted.current) return;
    
    console.log('[TERMINAL] Ending session permanently - destroying container');
    
    try {
      // If we have container info, call the container service to end the session
      if (containerInfo && containerInfo.containerId) {
        if (term.current && show) {
          term.current.writeln('\r\n\x1b[33m→ Ending session and destroying container...\x1b[0m');
        }
        
        // Call container service API to end session
        const response = await fetch('/api/containers/end-session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: socket.current?.id || 'unknown'
          })
        });
        
        if (response.ok) {
          const result = await response.json();
          console.log('[TERMINAL] Session ended successfully:', result);
          
          if (term.current && show) {
            term.current.writeln('\r\n\x1b[32m✓ Session ended and container destroyed\x1b[0m');
          }
        } else {
          console.error('[TERMINAL] Failed to end session via API');
        }
      }
      
      // Disconnect SSH and clear everything
      if (socket.current) {
        socket.current.emit('terminal:disconnect');
      }
      
      // Clear all session data and mark session as ended
      clearReconnectTimeout();
      autoConnectAttempted.current = false;
      sessionActive.current = false;
      setContainerInfo(null);
      setUseContainer(false);
      setSessionEnded(true); // Mark session as ended - prevents new containers
      setConnectionStatus('Session Ended');
      
      if (term.current && show) {
        term.current.writeln('\x1b[90mContainer has been destroyed. Restart server to create new containers.\x1b[0m\r\n');
      }
      
    } catch (error) {
      console.error('[TERMINAL] Error ending session:', error);
      if (term.current && show) {
        term.current.writeln(`\r\n\x1b[31m✗ Error ending session: ${error.message}\x1b[0m`);
      }
    }
  }, [containerInfo, clearReconnectTimeout, show]);

  // Clear terminal
  const clearTerminal = useCallback(() => {
    if (term.current && componentMounted.current && show) {
      term.current.clear();
      term.current.writeln('\x1b[32mTerminal cleared\x1b[0m\r\n');
    }
  }, [show]);

  // Download session log
  const downloadLog = useCallback(() => {
    const logData = sessionHistory.map(entry => 
      `[${new Date(entry.timestamp).toISOString()}] ${entry.type.toUpperCase()}: ${entry.data}`
    ).join('\n');
    
    const blob = new Blob([logData], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `terminal-session-${Date.now()}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [sessionHistory]);

  // Component lifecycle tracking
  useEffect(() => {
    console.log('[TERMINAL] Component mounted');
    componentMounted.current = true;
    
    return () => {
      console.log('[TERMINAL] Component unmounting');
      componentMounted.current = false;
      
      if (!maintainSession && !sessionActive.current) {
        initializationComplete.current = false;
      }
    };
  }, [maintainSession]);

  // Initialize socket connection (PERSISTENT - not affected by show/hide)
  useEffect(() => {
    if (!componentMounted.current) return;
    
    console.log('[TERMINAL] Setting up persistent connection');
    setupSocketConnection();
    
    return () => {
      console.log('[TERMINAL] Cleaning up socket connection');
      clearReconnectTimeout();
      autoConnectAttempted.current = false;
      
      if (!maintainSession) {
        if (socket.current) {
          socket.current.emit('terminal:disconnect');
          socket.current.disconnect();
          socket.current = null;
        }
        initializationComplete.current = false;
      }
    };
  }, [maintainSession, setupSocketConnection, clearReconnectTimeout]);

  // Terminal UI initialization (affected by show/hide)
  useEffect(() => {
    if (!show || !componentMounted.current) {
      return;
    }
    
    if (!initializationComplete.current) {
      initializeTerminal();
      setupResizeObserver();
    } else if (term.current) {
      setTimeout(() => {
        if (fitAddon.current && componentMounted.current && show && terminalRef.current) {
          try {
            fitAddon.current.fit();
          } catch (error) {
            console.warn('Refit error:', error);
          }
        }
        if (term.current && componentMounted.current && show) {
          term.current.focus();
        }
      }, 100);
    }
    
  }, [show, initializeTerminal, setupResizeObserver, maintainSession]);

  // Auto-connect effect - ONLY for initial connection, NOT for reconnections
  useEffect(() => {
    if (autoConnect && socket.current && !isConnected && !isConnecting && !isCreatingContainer &&
        !autoConnectAttempted.current && componentMounted.current && show && !containerInfo) {
      
      // Only auto-connect if we don't have an existing container (fresh start)
      console.log('[TERMINAL] Auto-connect triggered (initial connection only)');
      autoConnectAttempted.current = true;
      const timer = setTimeout(() => {
        if (componentMounted.current && !isConnected && !isConnecting && !isCreatingContainer && !containerInfo) {
          connectSSH();
        }
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, [autoConnect, connectSSH, isConnected, isConnecting, isCreatingContainer, show, containerInfo]);

  // Helper functions
  const getStatusColor = () => {
    if (isCreatingContainer) return '#f39c12';
    if (isConnecting) return '#f39c12';
    if (isConnected) return '#2ecc71';
    if (connectionError) return '#e74c3c';
    return '#95a5a6';
  };

  const getConnectionInfo = () => {
    if (isCreatingContainer) {
      return 'Creating container...';
    }
    if (isConnected) {
      if (containerInfo) {
        return `Container ${containerInfo.containerId.substring(0, 8)}... (${containerInfo.host}:${containerInfo.port})`;
      }
      return `${username}@${host}:${port}`;
    }
    if (connectionError) {
      return connectionError;
    }
    if (isConnecting) {
      return 'Connecting...';
    }
    return 'Not connected';
  };

  const getConnectButtonText = () => {
    if (isCreatingContainer) return 'Creating...';
    if (isConnecting) return 'Connecting...';
    return 'Connect';
  };

  const getReconnectButtonText = () => {
    if (isConnecting) return 'Reconnecting...';
    return 'Reconnect';
  };

  // Check if we can show reconnect options (disconnected but have container info)
  const canReconnect = !isConnected && !isConnecting && !isCreatingContainer && containerInfo;

  // Check if we should show normal connect (no container info or session ended)
  const canConnect = !isConnected && !isConnecting && !isCreatingContainer && !containerInfo;

  if (!show) {
    return null;
  }

  return (
    <div 
      className={`terminal-component ${className}`}
      style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        height: '100%',
        minHeight: '400px',
        backgroundColor: themes[theme]?.background || '#1e1e1e',
        fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", "Lucida Console", monospace',
        border: '1px solid #444',
        borderRadius: '8px',
        overflow: 'hidden',
        ...style 
      }}
    >
      {/* Status Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '8px 12px',
        backgroundColor: themes[theme]?.background === '#ffffff' ? '#f8f9fa' : '#2c3e50',
        borderBottom: themes[theme]?.background === '#ffffff' ? '1px solid #dee2e6' : '1px solid #34495e',
        fontSize: '13px',
        gap: '12px',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            backgroundColor: getStatusColor(),
            boxShadow: (isConnected || isCreatingContainer) ? `0 0 6px ${getStatusColor()}` : 'none'
          }} />
          <span style={{ color: themes[theme]?.foreground || '#ffffff', fontWeight: '500' }}>
            {connectionStatus}
          </span>
          {(containerInfo || useContainer) && (
            <span style={{ 
              fontSize: '11px', 
              color: '#999',
              backgroundColor: '#464647',
              padding: '2px 6px',
              borderRadius: '3px'
            }}>
              CONTAINER
            </span>
          )}
        </div>
        
        <div style={{ 
          color: themes[theme]?.foreground || '#ffffff', 
          opacity: 0.7,
          fontSize: '12px',
          maxWidth: '300px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}>
          {getConnectionInfo()}
        </div>
        
        <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
          {/* Normal Connect Button (for new connections) */}
          {canConnect && (
            <button
              onClick={connectSSH}
              style={{
                backgroundColor: '#3498db',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = '#2980b9';
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = '#3498db';
              }}
            >
              {getConnectButtonText()}
            </button>
          )}

          {/* Reconnect Button (when disconnected but container exists) */}
          {canReconnect && (
            <button
              onClick={reconnectSSH}
              style={{
                backgroundColor: '#27ae60',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = '#229954';
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = '#27ae60';
              }}
            >
              {getReconnectButtonText()}
            </button>
          )}

          {/* End Session Button (when disconnected but container exists) */}
          {canReconnect && (
            <button
              onClick={() => {
                if (confirm('Are you sure you want to end this session? This will destroy your container and all data will be lost.')) {
                  endSession();
                }
              }}
              style={{
                backgroundColor: '#e67e22',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = '#d35400';
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = '#e67e22';
              }}
              title="Destroy container and end session permanently"
            >
              End Session
            </button>
          )}
          
          {/* Disconnect Button (when connected) */}
          {(isConnected || isConnecting || isCreatingContainer) && (
            <button
              onClick={disconnectSSH}
              style={{
                backgroundColor: '#e74c3c',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.target.style.backgroundColor = '#c0392b'}
              onMouseLeave={(e) => e.target.style.backgroundColor = '#e74c3c'}
              title={containerInfo ? "Disconnect (container will remain alive)" : "Disconnect"}
            >
              {isCreatingContainer ? 'Cancel' : isConnecting ? 'Cancel' : 'Disconnect'}
            </button>
          )}
          
          <button
            onClick={clearTerminal}
            style={{
              backgroundColor: '#95a5a6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '11px',
              cursor: 'pointer',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#7f8c8d'}
            onMouseLeave={(e) => e.target.style.backgroundColor = '#95a5a6'}
          >
            Clear
          </button>
          
          {sessionHistory.length > 0 && (
            <button
              onClick={downloadLog}
              style={{
                backgroundColor: '#9b59b6',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.target.style.backgroundColor = '#8e44ad'}
              onMouseLeave={(e) => e.target.style.backgroundColor = '#9b59b6'}
            >
              Log
            </button>
          )}
        </div>
      </div>

      {/* Terminal */}
      <div 
        ref={terminalRef}
        style={{ 
          flex: 1, 
          minHeight: 0,
          padding: '8px',
          backgroundColor: themes[theme]?.background || '#1e1e1e'
        }}
        onClick={() => {
          if (term.current && componentMounted.current) {
            term.current.focus();
          }
        }}
      />
    </div>
  );
};

// Fixed ResizableTerminal component with session persistence
const ResizableTerminal = ({
  host = 'localhost',
  username = 'vboxuser',
  password = 'changeme',
  port = 2022,
  autoConnect = true,
  theme = 'dark',
  onConnect,
  onDisconnect,
  onStatusChange,
  initialHeight = 300,
  initialWidth = 100,
  minHeight = 100,
  maxHeight = 0.8,
  minWidth = 30,
  maxWidth = 100
}) => {
  const [isTerminalOpen, setIsTerminalOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(initialHeight);
  const [terminalWidth, setTerminalWidth] = useState(initialWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [isResizingWidth, setIsResizingWidth] = useState(false);
  const resizerRef = useRef(null);
  const widthResizerRef = useRef(null);
  const containerRef = useRef(null);

  const handleMouseDown = (e) => {
    setIsResizing(true);
    e.preventDefault();
  };

  const handleWidthMouseDown = (e) => {
    setIsResizingWidth(true);
    e.preventDefault();
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isResizing && containerRef.current) {
        const newHeight = window.innerHeight - e.clientY;
        const minHeightPx = minHeight;
        const maxHeightPx = window.innerHeight * maxHeight;
        
        if (newHeight >= minHeightPx && newHeight <= maxHeightPx) {
          setTerminalHeight(newHeight);
        }
      }

      if (isResizingWidth) {
        const newWidth = ((window.innerWidth - e.clientX) / window.innerWidth) * 100;
        if (newWidth >= minWidth && newWidth <= maxWidth) {
          setTerminalWidth(newWidth);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setIsResizingWidth(false);
    };

    if (isResizing || isResizingWidth) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, isResizingWidth, minHeight, maxHeight, minWidth, maxWidth]);

  const toggleTerminal = () => {
    const newOpenState = !isTerminalOpen;
    setIsTerminalOpen(newOpenState);
    
    // When opening the terminal, ensure it refits properly
    if (newOpenState) {
      setTimeout(() => {
        // Trigger a resize event to refit the terminal
        window.dispatchEvent(new Event('resize'));
      }, 100);
    }
  };

  return (
    <div 
      ref={containerRef}
      style={{
        position: 'fixed',
        bottom: 0,
        right: 0,
        width: `${terminalWidth}%`,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'transparent',
        fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", "Lucida Console", monospace',
        pointerEvents: 'none'
      }}
    >
      {/* Width Resizer */}
      {isTerminalOpen && (
        <div
          ref={widthResizerRef}
          onMouseDown={handleWidthMouseDown}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '4px',
            backgroundColor: isResizingWidth ? '#007acc' : 'transparent',
            cursor: 'col-resize',
            transition: 'background-color 0.2s ease',
            zIndex: 11,
            pointerEvents: 'auto'
          }}
          onMouseEnter={(e) => {
            if (!isResizingWidth) {
              e.target.style.backgroundColor = '#007acc40';
            }
          }}
          onMouseLeave={(e) => {
            if (!isResizingWidth) {
              e.target.style.backgroundColor = 'transparent';
            }
          }}
        />
      )}

      {/* Terminal Panel */}
      <div style={{
        borderTop: '1px solid #464647',
        backgroundColor: '#1e1e1e',
        display: 'flex',
        flexDirection: 'column',
        height: isTerminalOpen ? terminalHeight : 35,
        minHeight: isTerminalOpen ? minHeight : 35,
        transition: isTerminalOpen ? 'none' : 'height 0.2s ease',
        position: 'relative',
        pointerEvents: 'auto',
        boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.3)'
      }}>
        {/* Height Resizer */}
        {isTerminalOpen && (
          <div
            ref={resizerRef}
            onMouseDown={handleMouseDown}
            style={{
              height: '4px',
              backgroundColor: isResizing ? '#007acc' : 'transparent',
              cursor: 'row-resize',
              transition: 'background-color 0.2s ease',
              position: 'relative',
              zIndex: 10
            }}
            onMouseEnter={(e) => {
              if (!isResizing) {
                e.target.style.backgroundColor = '#007acc40';
              }
            }}
            onMouseLeave={(e) => {
              if (!isResizing) {
                e.target.style.backgroundColor = 'transparent';
              }
            }}
          />
        )}

        {/* Terminal Header */}
        <div style={{
          height: '35px',
          backgroundColor: '#2d2d30',
          borderBottom: isTerminalOpen ? '1px solid #464647' : 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 15px',
          fontSize: '13px',
          color: '#cccccc'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={toggleTerminal}
              style={{
                background: 'none',
                border: 'none',
                color: '#cccccc',
                cursor: 'pointer',
                fontSize: '16px',
                padding: '2px',
                display: 'flex',
                alignItems: 'center',
                transform: isTerminalOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.2s ease'
              }}
            >
              ▼
            </button>
            <span style={{ fontWeight: '500' }}>TERMINAL</span>
            {isTerminalOpen && (
              <span style={{ 
                fontSize: '11px', 
                color: '#999',
                backgroundColor: '#464647',
                padding: '2px 6px',
                borderRadius: '3px'
              }}>
                SSH
              </span>
            )}
          </div>
          
          {isTerminalOpen && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={toggleTerminal}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#cccccc',
                  cursor: 'pointer',
                  fontSize: '16px',
                  padding: '4px',
                  borderRadius: '3px',
                  opacity: 0.7
                }}
                onMouseEnter={(e) => {
                  e.target.style.backgroundColor = '#464647';
                  e.target.style.opacity = '1';
                }}
                onMouseLeave={(e) => {
                  e.target.style.backgroundColor = 'transparent';
                  e.target.style.opacity = '0.7';
                }}
                title="Minimize Panel"
              >
                −
              </button>
            </div>
          )}
        </div>

        {/* Terminal Content - ALWAYS RENDERED to maintain session */}
        <div style={{
          flex: 1,
          backgroundColor: '#1e1e1e',
          overflow: 'hidden',
          visibility: isTerminalOpen ? 'visible' : 'hidden', // Use visibility instead of display
          height: isTerminalOpen ? 'auto' : '0'
        }}>
          <TerminalComponent 
            show={true} // ALWAYS show to maintain terminal state
            maintainSession={true} // KEEP SESSION ALIVE when hidden
            host={host}
            username={username}
            password={password}
            port={port}
            autoConnect={autoConnect}
            theme={theme}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onStatusChange={onStatusChange}
            style={{
              height: '100%',
              border: 'none',
              borderRadius: '0',
              visibility: isTerminalOpen ? 'visible' : 'hidden'
            }}
          />
        </div>
      </div>

      {/* Resizing overlay */}
      {(isResizing || isResizingWidth) && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          cursor: isResizing ? 'row-resize' : 'col-resize',
          backgroundColor: 'rgba(0, 0, 0, 0.1)',
          zIndex: 9999,
          pointerEvents: 'auto'
        }} />
      )}
    </div>
  );
};

// Export both components
export default ResizableTerminal;
export { TerminalComponent };