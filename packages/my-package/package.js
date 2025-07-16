Package.describe({
  name: 'dharapo:terminal',
  version: '0.1.5',
  summary: 'Complete SSH Terminal with Container Service - React component with Meteor backend',
  git: '',
  documentation: 'README.md'
});

Package.onUse(function(api) {
  api.versionsFrom('3.3');
  api.use([
    'ecmascript@0.16.11',
    'react-meteor-data@4.0.0',
    'webapp@2.0.7',
    
  ]);

  // NPM dependencies for both terminal and container functionality
  Npm.depends({
    "uuid": "11.1.0",
    "xterm": "5.3.0",
    "xterm-addon-fit": "0.8.0",
    "xterm-addon-web-links": "0.9.0",
    'ssh2': '1.16.0', 
    "socket.io": "4.8.1",
    "socket.io-client": "4.8.1",
    // Container service dependencies
    "express": "4.21.2",
    "cors": "2.8.5",
    "node-fetch": "3.3.2"
  });

  // Export client-side components
  api.mainModule('client/TerminalComponent.jsx', 'client');
  
  // Export server-side functionality
  api.mainModule('server/main.js', 'server');
  
  // Add files to the package
  api.addFiles([
    'server/container/ContainerService.js',
    'server/container/dockerManager.js'
  ], 'server');
});

Package.onTest(function(api) {
  api.use(['ecmascript', 'tinytest', 'dharapo:terminal']);
});