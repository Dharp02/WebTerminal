Package.describe({
  name: 'dharapo:terminal',
  version: '0.0.2',
  summary: 'React component with Meteor backend example',
  git: '',
  documentation: 'README.md'
});

Package.onUse(function(api) {
  api.versionsFrom('3.3');
  api.use([
    'ecmascript@0.16.11',
    'react-meteor-data@4.0.0',
  
  ]);
Npm.depends({
    "uuid": "11.1.0",
    "xterm": "5.3.0",
    "xterm-addon-fit": "0.8.0",
    "xterm-addon-web-links": "0.9.0",
    'ssh2': '1.16.0', 
    "socket.io": "4.8.1",
    "socket.io-client": "4.8.1",
});

  api.mainModule('client/TerminalComponent.jsx', 'client');
  api.mainModule('server/main.js', 'server');
});

Package.onTest(function(api) {
  api.use(['ecmascript', 'tinytest', 'dharapo:terminal']);
});
