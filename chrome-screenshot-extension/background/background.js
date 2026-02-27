// Background service worker - handles screenshot capture requests from content script

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'take-screenshot') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return true;
    }

    chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 100
    }).then(dataUrl => {
      sendResponse({ dataUrl });
    }).catch(err => {
      sendResponse({ error: err.message });
    });

    return true; // keep channel open for async response
  }

  // Forward progress/done/error messages from content script to popup
  if (
    message.type === 'capture-progress' ||
    message.type === 'capture-done' ||
    message.type === 'capture-error'
  ) {
    chrome.runtime.sendMessage(message).catch(() => {
      // popup might be closed, ignore
    });
    return false;
  }

  // Handle download request for the zip blob
  if (message.type === 'download-zip') {
    const tabId = sender.tab?.id;
    if (!tabId) return false;

    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ downloadId });
      }
    });

    return true;
  }
});
