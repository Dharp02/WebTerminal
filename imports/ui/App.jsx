import React, { useState, useRef, useEffect } from 'react';
import TerminalComponent from './TerminalComponent.jsx';

const App = () => {
  const [isTerminalOpen, setIsTerminalOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(300);
  const [terminalWidth, setTerminalWidth] = useState(100); // Percentage of screen width
  const [isResizing, setIsResizing] = useState(false);
  const [isResizingWidth, setIsResizingWidth] = useState(false);
  const resizerRef = useRef(null);
  const widthResizerRef = useRef(null);
  const containerRef = useRef(null);

  // Handle mouse down on resizers
  const handleMouseDown = (e) => {
    setIsResizing(true);
    e.preventDefault();
  };

  const handleWidthMouseDown = (e) => {
    setIsResizingWidth(true);
    e.preventDefault();
  };

  // Handle mouse move for resizing
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isResizing && containerRef.current) {
        const newHeight = window.innerHeight - e.clientY;
        
        // Min height 100px, max height 80% of viewport
        const minHeight = 100;
        const maxHeight = window.innerHeight * 0.8;
        
        if (newHeight >= minHeight && newHeight <= maxHeight) {
          setTerminalHeight(newHeight);
        }
      }

      if (isResizingWidth) {
        const newWidth = ((window.innerWidth - e.clientX) / window.innerWidth) * 100;
        
        // Min width 30%, max width 100%
        const minWidth = 30;
        const maxWidth = 100;
        
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
  }, [isResizing, isResizingWidth]);

  const toggleTerminal = () => {
    setIsTerminalOpen(!isTerminalOpen);
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
        minHeight: isTerminalOpen ? 100 : 35,
        transition: isTerminalOpen ? 'none' : 'height 0.2s ease',
        position: 'relative',
        pointerEvents: 'auto',
        boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.3)'
      }}>
        {/* Resizer */}
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
                title="Close Panel"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {/* Terminal Content */}
        {isTerminalOpen && (
          <div style={{
            flex: 1,
            backgroundColor: '#1e1e1e',
            overflow: 'hidden'
          }}>
            <TerminalComponent 
              show={true}
              host="localhost"
              username="vboxuser"
              password="changeme"
              port={2022}
              autoConnect={true}
              theme="dark"
              onConnect={() => console.log('Connected!')}
              onDisconnect={() => console.log('Disconnected!')}
              onStatusChange={(status) => console.log('Status:', status)}
              style={{
                height: '100%',
                border: 'none',
                borderRadius: '0'
              }}
            />
          </div>
        )}
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
          zIndex: 9999
        }} />
      )}
    </div>
  );
};

export default App;