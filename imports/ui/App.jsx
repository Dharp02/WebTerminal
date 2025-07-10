import React from 'react';
import TerminalComponent from './TerminalComponent.jsx';

export const App = () => (
  <div>
    <TerminalComponent
      host="localhost"
      username="vboxuser"
      password="changeme"
      port={2022}
      autoConnect={true}
      theme="dark"
      onConnect={() => console.log('Connected!')}
      onDisconnect={() => console.log('Disconnected!')}
      onStatusChange={(status) => console.log('Status:', status)}
    />
  </div>
);