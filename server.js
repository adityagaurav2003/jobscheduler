console.log("FILE IS RUNNING");
import express from 'express';
import { db } from './db/index.js';
import { jobStateTable } from './db/schema.js';


const app = express();
const PORT = 8000;

app.use(express.json());
app.get('/', (req, res) => {
  return res.json({message: 'server is running successfully'});
});

app.post('/job', async(req, res) => {
  const {image, cmd=null} = req.body;
  const [insertResult] = await db.insert(jobStateTable).values({image, cmd}).returning({id: jobStateTable.id});
  return res.json({jobId: insertResult.id});
});

app.listen(PORT, () => {
  console.log(`server is running on port ${PORT}`);
});