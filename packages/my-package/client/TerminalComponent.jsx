import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import io from 'socket.io-client';
import 'xterm/css/xterm.css';

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
  passphrase = ''
}) => {
  const terminalRef = useRef(null);
  const term = useRef(null);
  const fitAddon = useRef(new FitAddon());
  const socket = useRef(null);
  const resizeObserver = useRef(null);
  const autoConnectAttempted = useRef(false);
  const reconnectTimeout = useRef(null);
  const componentMounted = useRef(true);
  const initializationComplete = useRef(false); // Track if we've initialized
  
  const [isConnected, setIsConnected] = useState(externalIsConnected);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [isConnecting, setIsConnecting] = useState(false);
  const [sessionHistory, setSessionHistory] = useState([]);
  const [connectionError, setConnectionError] = useState(null);

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

  // Handle local input when not connected - using useCallback with empty deps
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
  }, []); // Empty dependencies - this function doesn't need to recreate

  // Setup resize observer - stable version
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
  }, []); // Empty dependencies

  // Initialize terminal - stable version that doesn't depend on changing state
  const initializeTerminal = useCallback(() => {
    if (!terminalRef.current || !componentMounted.current || initializationComplete.current) {
      return;
    }

    console.log('[TERMINAL] Initializing terminal');

    // Create new terminal
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

    // Load addons
    term.current.loadAddon(fitAddon.current);
    
    // Open terminal
    term.current.open(terminalRef.current);

    // Write welcome message
    term.current.writeln('\x1b[36m╭─────────────────────────────────────╮\x1b[0m');
    term.current.writeln('\x1b[36m│        SSH Terminal Component        │\x1b[0m');
    term.current.writeln('\x1b[36m╰─────────────────────────────────────╯\x1b[0m');
    term.current.writeln('\x1b[32mReady to connect...\x1b[0m');
    term.current.writeln('\x1b[90mPress Ctrl+C to interrupt, type "exit" to disconnect\x1b[0m\r\n');

    // Setup resize observer
   // setupResizeObserver();

    // Handle terminal input
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

    // Handle selection for copy/paste
    term.current.onSelectionChange(() => {
      const selection = term.current.getSelection();
      if (selection) {
        navigator.clipboard?.writeText(selection).catch(() => {
          console.log('Could not copy to clipboard');
        });
      }
    });

    // Initial fit and focus
    setTimeout(() => {
      if (fitAddon.current && componentMounted.current) {
        try {
          fitAddon.current.fit();
        } catch (error) {
          console.warn('Initial fit error:', error);
        }
      }
      if (term.current && componentMounted.current) {
        term.current.focus();
      }
    }, 100);

    initializationComplete.current = true;
    console.log('[TERMINAL] Terminal initialized successfully');
  }, [theme, handleLocalInput]); // Only depend on stable things

  // Setup socket connection - stable version
  const setupSocketConnection = useCallback(() => {
    if (!componentMounted.current || socket.current) {
      return;
    }

    console.log('[TERMINAL] Setting up socket connection');

    socket.current = io(window.location.origin, {
      forceNew: true,
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnection: false
    });

    socket.current.on('connect', () => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Socket connected to server');
      if (term.current) {
        term.current.writeln('\r\n\x1b[32m✓ Connected to server\x1b[0m');
      }
    });

    socket.current.on('connect_error', (error) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Socket connection error:', error.message);
      setConnectionError(`Server connection failed: ${error.message}`);
      if (term.current) {
        term.current.writeln(`\r\n\x1b[31m✗ Server connection failed: ${error.message}\x1b[0m`);
      }
    });

    socket.current.on('disconnect', (reason) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] Socket disconnected:', reason);
      setIsConnected(false);
      setConnectionStatus('Disconnected');
      setIsConnecting(false);
      clearReconnectTimeout();
      onStatusChange?.('disconnected');
      onDisconnect?.();
      
      if (term.current) {
        term.current.writeln(`\r\n\x1b[31m✗ Disconnected from server (${reason})\x1b[0m`);
      }
    });

    socket.current.on('terminal:output', data => {
      if (!componentMounted.current) return;
      if (term.current) {
        term.current.write(data);
        setSessionHistory(prev => [...prev.slice(-100), { 
          type: 'output', 
          data, 
          timestamp: Date.now() 
        }]);
      }
    });

    socket.current.on('terminal:connected', (data) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] SSH Connected successfully:', data);
      setConnectionStatus('SSH Connected');
      setIsConnected(true);
      setIsConnecting(false);
      setConnectionError(null);
      clearReconnectTimeout();
      onStatusChange?.('connected');
      onConnect?.();
      
      if (term.current) {
        term.current.writeln('\r\n\x1b[32m✓ SSH Connection established\x1b[0m');
        term.current.writeln(`\x1b[90mConnected to ${data.username}@${data.host}:${data.port}\x1b[0m\r\n`);
      }
    });

    socket.current.on('terminal:error', (error) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] SSH Error:', error.message);
      setIsConnecting(false);
      setConnectionStatus('Error');
      setConnectionError(error.message);
      clearReconnectTimeout();
      onStatusChange?.('error');
      
      if (term.current) {
        term.current.writeln(`\r\n\x1b[31m✗ SSH Error: ${error.message}\x1b[0m\r\n`);
      }
    });

    socket.current.on('terminal:disconnected', (data) => {
      if (!componentMounted.current) return;
      console.log('[TERMINAL] SSH Disconnected:', data);
      setIsConnected(false);
      setConnectionStatus('Disconnected');
      setIsConnecting(false);
      clearReconnectTimeout();
      onStatusChange?.('disconnected');
      onDisconnect?.();
      
      if (term.current) {
        const reason = data?.reason ? ` (${data.reason})` : '';
        term.current.writeln(`\r\n\x1b[33m✗ SSH session ended${reason}\x1b[0m\r\n`);
      }
    });

    console.log('[TERMINAL] Socket event handlers set up');
  }, [onConnect, onDisconnect, onStatusChange, clearReconnectTimeout]); // Stable dependencies

  // Connect to SSH
  const connectSSH = useCallback(() => {
    if (!componentMounted.current || !socket.current || isConnecting || isConnected) {
      return;
    }

    console.log('[TERMINAL] Starting SSH connection');

    // Clear any previous errors
    setConnectionError(null);

    // Validate inputs
    if (!host.trim() || !username.trim() || (!password.trim() && !useKeyAuth)) {
      const errorMsg = 'Missing required connection parameters';
      setConnectionError(errorMsg);
      if (term.current) {
        term.current.writeln('\r\n\x1b[31m✗ Missing required connection parameters\x1b[0m');
      }
      return;
    }

    setIsConnecting(true);
    setConnectionStatus('Connecting...');
    clearReconnectTimeout();
    
    if (term.current) {
      term.current.writeln(`\r\n\x1b[33m→ Connecting to ${username}@${host}:${port}...\x1b[0m`);
    }

    const credentials = {
      host,
      port: parseInt(port),
      username,
      useKeyAuth
    };

    if (useKeyAuth) {
      credentials.privateKey = privateKey;
      if (passphrase) {
        credentials.passphrase = passphrase;
      }
    } else {
      credentials.password = password;
    }

    socket.current.emit('terminal:connect', credentials);
  }, [host, username, password, port, useKeyAuth, privateKey, passphrase, 
      isConnecting, isConnected, clearReconnectTimeout]);

  // Disconnect from SSH
  const disconnectSSH = useCallback(() => {
    if (!componentMounted.current) return;
    
    console.log('[TERMINAL] Disconnecting SSH');
    clearReconnectTimeout();
    autoConnectAttempted.current = false;
    
    if (socket.current) {
      socket.current.emit('terminal:disconnect');
    }
  }, [clearReconnectTimeout]);

  // Clear terminal
  const clearTerminal = useCallback(() => {
    if (term.current && componentMounted.current) {
      term.current.clear();
      term.current.writeln('\x1b[32mTerminal cleared\x1b[0m\r\n');
    }
  }, []);

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
      initializationComplete.current = false;
    };
  }, []);

  // Main initialization effect - ONLY runs once when component mounts and show becomes true
  useEffect(() => {
    if (!show || !componentMounted.current || initializationComplete.current) {
      return;
    }
    
    console.log('[TERMINAL] Running main initialization effect');
    
    // Initialize terminal and socket
    initializeTerminal();
    setupSocketConnection();
    
    // Cleanup function
    return () => {
      console.log('[TERMINAL] Main effect cleanup');
      clearReconnectTimeout();
      autoConnectAttempted.current = false;
      
      if (socket.current) {
        socket.current.emit('terminal:disconnect');
        socket.current.disconnect();
        socket.current = null;
      }
      
      if (term.current) {
        term.current.dispose();
        term.current = null;
      }
      
      if (resizeObserver.current) {
        resizeObserver.current.disconnect();
        resizeObserver.current = null;
      }
      
      initializationComplete.current = false;
    };
  }, [show]); // ONLY depend on show prop

  // Auto-connect effect (only once)
  useEffect(() => {
    if (autoConnect && socket.current && !isConnected && !isConnecting && 
        !autoConnectAttempted.current && componentMounted.current && 
        initializationComplete.current) {
      
      console.log('[TERMINAL] Auto-connect triggered');
      autoConnectAttempted.current = true;
      const timer = setTimeout(() => {
        if (componentMounted.current && !isConnected && !isConnecting) {
          connectSSH();
        }
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, [autoConnect, connectSSH, isConnected, isConnecting]);

  // Helper functions
  const getStatusColor = () => {
    if (isConnecting) return '#f39c12';
    if (isConnected) return '#2ecc71';
    if (connectionError) return '#e74c3c';
    return '#95a5a6';
  };

  const getConnectionInfo = () => {
    if (isConnected) {
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
            boxShadow: isConnected ? `0 0 6px ${getStatusColor()}` : 'none'
          }} />
          <span style={{ color: themes[theme]?.foreground || '#ffffff', fontWeight: '500' }}>
            {connectionStatus}
          </span>
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
          {!isConnected && !isConnecting && (
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
              onMouseEnter={(e) => e.target.style.backgroundColor = '#2980b9'}
              onMouseLeave={(e) => e.target.style.backgroundColor = '#3498db'}
            >
              Connect
            </button>
          )}
          
          {(isConnected || isConnecting) && (
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
            >
              {isConnecting ? 'Cancel' : 'Disconnect'}
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

export default TerminalComponent;