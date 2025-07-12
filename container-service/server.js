const express = require('express');
const cors = require('cors');
const containerRoutes = require('./routes/container');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/containers', containerRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'container-service' });
});

app.listen(PORT, () => {
  console.log(`Container service running on port ${PORT}`);
});