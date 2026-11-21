<script setup lang="ts">
definePageMeta({ layout: 'public', key: (to) => to.path });
</script>

<template>
	<DocsMirrorPage mirror="spool" />
</template>
