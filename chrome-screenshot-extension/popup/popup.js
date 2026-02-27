document.addEventListener('DOMContentLoaded', () => {
  const btnStart = document.getElementById('btn-start');
  const progressArea = document.getElementById('progress-area');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const stats = document.getElementById('stats');
  const statSections = document.getElementById('stat-sections');
  const statAnimations = document.getElementById('stat-animations');
  const statFrames = document.getElementById('stat-frames');
  const doneArea = document.getElementById('done-area');
  const doneDetails = document.getElementById('done-details');
  const errorArea = document.getElementById('error-area');
  const errorMessage = document.getElementById('error-message');
  const fpsSelect = document.getElementById('fps');
  const qualitySelect = document.getElementById('quality');

  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    progressArea.classList.remove('hidden');
    doneArea.classList.add('hidden');
    errorArea.classList.add('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Iniciando captura...';

    const fps = parseInt(fpsSelect.value);
    const quality = parseFloat(qualitySelect.value);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) {
        throw new Error('Nenhuma aba ativa encontrada.');
      }

      // Listen for progress messages from content script via background
      const messageListener = (message) => {
        if (message.type === 'capture-progress') {
          const { percent, text, sections, animations, frames } = message;
          progressFill.style.width = `${percent}%`;
          progressText.textContent = text;
          if (sections !== undefined) {
            stats.classList.remove('hidden');
            statSections.textContent = `${sections} seções`;
            statAnimations.textContent = `${animations} animações`;
            statFrames.textContent = `${frames} frames`;
          }
        } else if (message.type === 'capture-done') {
          progressFill.style.width = '100%';
          progressText.textContent = 'Concluído!';
          doneArea.classList.remove('hidden');
          doneDetails.textContent = `${message.totalFiles} imagens capturadas em ${message.sections} seções`;
          btnStart.disabled = false;
          chrome.runtime.onMessage.removeListener(messageListener);
        } else if (message.type === 'capture-error') {
          throw new Error(message.error);
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      // Send the start message to the content script
      chrome.tabs.sendMessage(tab.id, {
        type: 'start-capture',
        options: { fps, quality }
      });

    } catch (err) {
      errorArea.classList.remove('hidden');
      errorMessage.textContent = `Erro: ${err.message}`;
      btnStart.disabled = false;
    }
  });
});
