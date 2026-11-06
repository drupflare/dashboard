export default {
	fetch() {
		return new Response('<!doctype html><title>tenant</title><p>ok</p>', {
			status: 200,
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});
	}
};
