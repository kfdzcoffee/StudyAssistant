// ===== 同步路由 =====
const express = require('express');
const { auth } = require('../middleware/auth');
const { pushCollection, pullCollection, pullAll } = require('../sync/engine');

const router = express.Router();
router.use(auth);

// 推送：POST /api/sync/:collection
// body: { records: [...] }
router.post('/:collection', async (req, res) => {
  const { collection } = req.params;
  const { records } = req.body || {};
  const r = await pushCollection(req.user.id, collection, records);
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

// 拉取（增量）：GET /api/sync/:collection?since=<ISO>
router.get('/:collection', async (req, res) => {
  const { collection } = req.params;
  const { since } = req.query;
  const r = await pullCollection(req.user.id, collection, since);
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

// 全量拉取：GET /api/sync/:collection/all
router.get('/:collection/all', async (req, res) => {
  const { collection } = req.params;
  const r = await pullAll(req.user.id, collection);
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

module.exports = router;
