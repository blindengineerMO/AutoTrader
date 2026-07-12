const express = require('express');
const { z } = require('zod');
const authService = require('../services/authService');

const router = express.Router();

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

router.post('/register', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const result = await authService.register(parsed.data);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const result = await authService.login(parsed.data);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
