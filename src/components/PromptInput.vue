<template>
  <div class="prompt-panel" style="pointer-events: auto" @click.stop>
    <!-- Password gate -->
    <div v-if="!isAuthenticated" class="prompt-auth">
      <form @submit.prevent="handleAuth" class="auth-form">
        <input
          v-model="password"
          type="password"
          placeholder="Enter beta password"
          class="auth-input"
          aria-label="Beta password"
        />
        <button type="submit" class="auth-submit" :disabled="!password">Go</button>
      </form>
      <p v-if="error" class="prompt-error">{{ error }}</p>
    </div>

    <!-- Prompt input -->
    <div v-else class="prompt-main">
      <form @submit.prevent="handleSubmit" class="prompt-form">
        <input
          v-model="query"
          type="text"
          placeholder="Describe what you're looking for..."
          class="prompt-input"
          :disabled="isLoading"
          aria-label="Search query for county livability"
          maxlength="500"
        />
        <button type="submit" class="prompt-submit" :disabled="isLoading || !query.trim()">
          <span v-if="!isLoading">Search</span>
          <span v-else class="prompt-spinner"></span>
        </button>
      </form>

      <!-- Suggested chips -->
      <div v-if="!explanation && !isLoading" class="prompt-chips">
        <button
          v-for="chip in suggestedQueries"
          :key="chip"
          class="prompt-chip"
          @click="submitChip(chip)"
          :disabled="isLoading"
        >{{ chip }}</button>
      </div>

      <!-- Explanation -->
      <div v-if="explanation" class="prompt-explanation">
        <p>{{ explanation }}</p>
      </div>

      <!-- Error -->
      <p v-if="error" class="prompt-error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { usePromptQuery, type QueryResponse } from '@/composables/usePromptQuery'

const emit = defineEmits<{
  'query-result': [result: QueryResponse]
}>()

const {
  isAuthenticated,
  isLoading,
  error,
  explanation,
  authenticate,
  submitQuery,
} = usePromptQuery()

const password = ref('')
const query = ref('')

const suggestedQueries = [
  'Affordable counties with strong Black community',
  'Best places for Black homeownership',
  'Low pollution, good wages, diverse neighborhoods',
]

async function handleAuth() {
  await authenticate(password.value)
  password.value = ''
}

async function handleSubmit() {
  if (!query.value.trim()) return
  const result = await submitQuery(query.value.trim())
  if (result) {
    emit('query-result', result)
  }
}

async function submitChip(chip: string) {
  query.value = chip
  const result = await submitQuery(chip)
  if (result) {
    emit('query-result', result)
  }
}
</script>

<style scoped>
.prompt-panel {
  position: absolute;
  top: 10px;
  left: 310px;
  right: 270px;
  z-index: 5;
  max-width: 500px;
}

.auth-form,
.prompt-form {
  display: flex;
  gap: 4px;
  background: white;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  padding: 4px;
}

.auth-input,
.prompt-input {
  flex: 1;
  border: none;
  padding: 8px 12px;
  font-size: 14px;
  border-radius: 4px;
  outline: none;
  min-width: 0;
}

.auth-input::placeholder,
.prompt-input::placeholder {
  color: #999;
}

.auth-submit,
.prompt-submit {
  padding: 8px 16px;
  background: #4a7c59;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.auth-submit:hover,
.prompt-submit:hover {
  background: #3d6b4a;
}

.auth-submit:disabled,
.prompt-submit:disabled {
  background: #999;
  cursor: not-allowed;
}

.prompt-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.prompt-chips {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.prompt-chip {
  padding: 4px 10px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 14px;
  font-size: 11px;
  color: #555;
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.prompt-chip:hover {
  border-color: #4a7c59;
  color: #4a7c59;
  background: #f0f7f2;
}

.prompt-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.prompt-explanation {
  margin-top: 6px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 6px;
  border-left: 3px solid #4a7c59;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}

.prompt-explanation p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #444;
}

.prompt-error {
  margin: 6px 0 0;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 4px;
  border-left: 3px solid #c0392b;
  font-size: 12px;
  color: #c0392b;
}

@media (max-width: 768px) {
  .prompt-panel {
    position: relative;
    top: auto;
    left: auto;
    right: auto;
    max-width: none;
    margin: 8px;
  }
}
</style>
