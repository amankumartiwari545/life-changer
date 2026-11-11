import express from 'express';
import { pathToFileURL } from 'node:url';
import feedRouter from './routes/feed.js';
import uploadRouter from './routes/upload.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use('/api/upload', uploadRouter);
app.use('/api/feed', feedRouter);

export default app;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, () => {
    console.log(`External manager API listening on port ${port}`);
  });
}