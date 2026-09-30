import serverless from 'serverless-http';
import app from '../../server.js';

const expressHandler = serverless(app);
const functionPrefix = '/.netlify/functions/api';

export const handler = async (event, context) => {
  if (event.path.startsWith(functionPrefix)) {
    event.path = event.path.slice(functionPrefix.length) || '/';
  }
  if (event.path !== '/' && !event.path.startsWith('/api/')) {
    event.path = `/api${event.path}`;
  }
  return expressHandler(event, context);
};
