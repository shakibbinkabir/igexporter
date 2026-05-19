# Instagram Chat Exporter

A Chrome extension to export Instagram direct message conversations to JSON format with a single click.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `igexporter` folder

## Usage

1. Go to [Instagram Direct Messages](https://www.instagram.com/direct/inbox/)
2. Open the chat conversation you want to export
3. Click the extension icon in your Chrome toolbar
4. Click **Export Chat**
5. Choose where to save the JSON file

## Exported Data Format

The exported JSON file contains:

```json
{
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chatName": "username",
  "participants": ["You", "username"],
  "messageCount": 150,
  "messages": [
    {
      "id": 0,
      "content": "Message text here",
      "sender": "You",
      "timestamp": "2024-01-15T10:00:00.000Z",
      "type": "text"
    }
  ]
}
```

## Features

- Export chat messages to JSON format
- Captures text messages
- Identifies sender (You vs. other participant)
- Includes timestamps when available
- Detects media messages (images/videos)

## Limitations

- Instagram's dynamic page structure may affect message extraction
- Very old messages may require scrolling to load them first
- Some timestamps may not be captured if Instagram doesn't display them

## Better Icons (Optional)

The extension comes with placeholder icons. For better icons:
1. Open `generate-icons.html` in a browser
2. Click "Download All Icons"
3. Replace the files in the `icons` folder
4. Reload the extension in Chrome

## Privacy

This extension runs entirely locally. No data is sent to external servers.
