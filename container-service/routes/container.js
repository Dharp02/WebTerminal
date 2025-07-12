const express = require('express');
const { DockerManager } = require('../services/dockermanager');

const router = express.Router();
const dockerManager = new DockerManager();

// Create container
router.post('/create', async (req, res) => {
  try {
    console.log('[CONTAINER] Creating new SSH container...');
    const container = await dockerManager.createSSHContainer();

    console.log('[CONTAINER] Container created successfully:', container.containerId);
    res.json({ success: true, container });
  } catch (error) {
    console.error('[CONTAINER] Container creation failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List containers
router.get('/list', (req, res) => {
  try {
    const containers = dockerManager.getAllContainers();
    res.json({ containers });
  } catch (error) {
    console.error('[CONTAINER] Error listing containers:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stop container
router.delete('/:id', async (req, res) => {
  try {
    await dockerManager.stopContainer(req.params.id);
    res.json({ success: true, message: 'Container stopped successfully' });
  } catch (error) {
    console.error('[CONTAINER] Error stopping container:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get container stats
router.get('/stats', (req, res) => {
  try {
    const stats = dockerManager.getContainerStats();
    res.json(stats);
  } catch (error) {
    console.error('[CONTAINER] Error getting stats:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;