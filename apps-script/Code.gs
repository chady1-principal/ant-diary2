var HEADERS = ['날짜', '시간', '날씨', '본문'];

function getDiarySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function rowToEntry(row) {
  return {
    date: String(row[0] || ''),
    time: String(row[1] || ''),
    weather: String(row[2] || ''),
    content: String(row[3] || '')
  };
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action || 'list';
    var sheet = getDiarySheet();

    if (action === 'ping') {
      return jsonResponse({
        ok: true,
        spreadsheetName: SpreadsheetApp.getActiveSpreadsheet().getName(),
        sheetName: sheet.getName(),
        count: Math.max(0, sheet.getLastRow() - 1)
      });
    }

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return jsonResponse({ ok: true, entries: [] });
    }

    var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    var entries = [];
    var i;
    for (i = values.length - 1; i >= 0; i--) {
      if (values[i][3]) {
        entries.push(rowToEntry(values[i]));
      }
    }

    var q = (params.q || '').trim().toLowerCase();
    if (q) {
      entries = entries.filter(function (item) {
        var haystack = [item.date, item.time, item.weather, item.content].join(' ').toLowerCase();
        return haystack.indexOf(q) !== -1;
      });
    }

    return jsonResponse({ ok: true, entries: entries });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) });
  }
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    var body = JSON.parse(raw);
    var sheet = getDiarySheet();

    var now = new Date();
    var date = body.date || Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
    var time = body.time || Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm');
    var weather = String(body.weather || body.mood || '');
    var content = String(body.content || '').trim();

    if (!content) {
      return jsonResponse({ ok: false, error: '일기 본문이 비어 있습니다.' });
    }

    var newRow = [date, time, weather, content];
    sheet.appendRow(newRow);

    return jsonResponse({
      ok: true,
      entry: rowToEntry(newRow)
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) });
  }
}
