import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import { ROOT, PUBLIC_DIR } from './lib/paths.js';
import { api } from './routes/api.js';

dotenv.config({ path: path.join(ROOT, '.env') });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/api', api);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal error' });
});

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

app.listen(port, host, () => {
  console.log(`cmf-pipeline  http://${host}:${port}`);
  console.log(`search API    http://${host}:${port}/api/search?query=`);
});
