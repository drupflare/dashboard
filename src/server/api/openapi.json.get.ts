import { defineEventHandler, setResponseHeader } from 'h3';
import spec from '../../../contracts/openapi.json';

const body = JSON.stringify(spec);

export default defineEventHandler((event) => {
	setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
	setResponseHeader(event, 'Cache-Control', 'public, max-age=300');
	return body;
});
