const express = require('express');
const { z } = require('zod');
const requireAdmin = require('../middleware/admin');
const userAdminService = require('../services/userAdminService');

const router = express.Router();

router.use(requireAdmin);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  role: z.enum(['user', 'admin']).default('user'),
  status: z.enum(['active', 'disabled']).default('active'),
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(['user', 'admin']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const passwordSchema = z.object({
  password: z.string().min(8).max(200),
});

const userQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(200).optional(),
  role: z.enum(['', 'user', 'admin']).optional(),
  status: z.enum(['', 'active', 'disabled']).optional(),
  sortBy: z.enum(['email', 'role', 'status', 'created_at', 'updated_at', 'last_login_at', 'password_changed_at']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

router.get('/users', (req, res) => {
  const parsed = userQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid user query' });
  res.json(userAdminService.listUsers(parsed.data));
});

router.post('/users', async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    res.status(201).json(await userAdminService.createUser(parsed.data));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/users/:id', (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    res.json(userAdminService.updateUser(Number(req.params.id), parsed.data));
  } catch (err) {
    res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
  }
});

router.post('/users/:id/password', async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    res.json(await userAdminService.resetPassword(Number(req.params.id), parsed.data.password));
  } catch (err) {
    res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
  }
});

router.delete('/users/:id', (req, res) => {
  try {
    res.json(userAdminService.deleteUser(Number(req.params.id), { actorId: req.user.id }));
  } catch (err) {
    res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
  }
});

module.exports = router;
