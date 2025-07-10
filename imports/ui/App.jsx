import React from 'react';

import TerminalComponent from './TerminalComponent.jsx';

export const App = () => (
  <div>


<TerminalComponent 
  show={true}
  host="localhost"
  username="vboxuser"
  password="changeme"
  port={2022}
  autoConnect={true}  // Changed this to false
  theme="dark"
  onConnect={() => console.log('Connected!')}
  onDisconnect={() => console.log('Disconnected!')}
  onStatusChange={(status) => console.log('Status:', status)}
/>
  </div>
);
