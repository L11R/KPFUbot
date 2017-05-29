/**
 * Created by savely on 28.05.17.
 */
const cfg = require('./config');

const request = require('request-promise-native');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(cfg.private.token, {polling: true});

const r = require('rethinkdbdash')(cfg.private.rethinkdb);

function getDay(schedule, day) {
	let text = '';

	for (let i in schedule[day]) {
		const temp = schedule[day][i];
		text += `<b>${schedule[0][i]}</b>\n`;

		if (temp.length === 0)
			text += '-/-\n\n';
		else if (i === '0')
			text += `<b>${temp}</b>\n\n`;
		else
			text += `${temp}\n\n`;
	}

	return text;
}

function fetchSchedule(group) {
	const options = {
		url: `http://kpfu.ru/week_sheadule_print?p_group_name=${group}`,
		encoding: null
	};

	return new Promise(function (resolve, reject) {
		request.get(options)
			.then(function (res) {
				// Cheerio скармливаем HTML сразу с UTF-8
				const body = iconv.decode(Buffer.from(res), 'win1251');
				const $ = cheerio.load(body);

				if (body.indexOf('Расписание не найдено') > -1)
					throw new Error('Group not found!');
				else {
					// temp это сырой двумерный массив с расписанием
					const temp = [];

					$('tr').each(function (i) {
						temp[i] = [];
						$('td', this).each(function (j) {
							$('br', this).remove();
							$('font', this).prepend('\n');
							$('font', this).append('\n');

							temp[i][j] = $(this).text().trim();
						})
					});

					// А вот schedule это уже транспонированный temp,
					// с которым гораздо удобней работать
					const schedule = [];

					for (let i in temp[0]) {
						schedule[i] = [];
						for (let j in temp) {
							schedule[i][j] = temp[j][i];
						}
					}

					// Сохраняем этот массив
					return r.table('groups').insert({
						id: group,
						schedule: schedule,
						date: r.now()
					}, {conflict: 'update'});
				}
			})

			.then(function (res) {
				resolve(res);
			})

			.catch(function (error) {
				reject(error);
			});
	});
}

bot.onText(/^\/start/, function (msg) {
	const param = msg.text.split(' ')[1];

	if (param === 'inline')
		bot.sendMessage(msg.chat.id, 'Сохрани профиль, используя команду ' +
			'<code>/save [номер группы]</code>', {parse_mode: 'HTML'});
	else
		bot.sendMessage(msg.chat.id, 'Простой бот, который отображает расписание группы КФУ ' +
			'посредством inline-режима (аналогично боту @gif и другим).\n' +
			'Краткая справка: /help');
});

bot.onText(/^\/help/, function (msg) {
	bot.sendMessage(msg.chat.id,
		'/save - сохраняет вашу группу.\n' +
		'/delete - полностью удаляет ваш профиль из бота.\n' +
		'/status - отображает текущий статус.\n' +
		'Дальнейшее взаимодействие посредством inline!');
});

bot.onText(/^\/save/, function (msg) {
	bot.sendMessage(msg.chat.id, 'Введите группу:', {reply_markup: {force_reply: true}})
		.then(function (res) {
			return new Promise(function (resolve) {
				bot.onReplyToMessage(msg.chat.id, res.message_id, function (group) {
					resolve(group.text);
				});
			});
		})

		.then(function (group) {
			r.table('users').insert({
				id: msg.from.id,
				group: group
			}, {conflict: 'update'})
				.then(function (res) {
					return fetchSchedule(group);
				})

				.then(function (res) {
					console.log(res);
					bot.sendMessage(msg.chat.id, 'Сохранено!');
				})

				.catch(function (error) {
					console.warn(error.message);
					bot.sendMessage(msg.chat.id, `Что-то пошло не так!\n<code>${error.message}</code>`, {parse_mode: 'HTML'});
				});
		});
});

bot.onText(/^\/update/, function (msg) {
	r.table('users')
		.get(msg.from.id)

		.then(function (res) {
			return fetchSchedule(res.group);
		})

		.then(function (res) {
			console.log(res);
			bot.sendMessage(msg.chat.id, 'Обновлено!');
		})

		.catch(function (error) {
			console.warn(error.message);
			bot.sendMessage(msg.chat.id, `Что-то пошло не так!\n<code>${error.message}</code>`, {parse_mode: 'HTML'});
		});
});

bot.onText(/^\/delete/, function (msg) {
	r.table('users')
		.get(msg.from.id).delete()

		.then(function (res) {
			console.log(res);
			bot.sendMessage(msg.chat.id, 'Удалено!');
		})

		.catch(function (error) {
			console.warn(error.message);
			bot.sendMessage(msg.chat.id, `Что-то пошло не так!\n<code>${error.message}</code>`, {parse_mode: 'HTML'});
		});
});

bot.onText(/^\/status/, function (msg) {
	r.table('groups')
		.get(
			r.table('users').get(msg.from.id)('group')
		)

		.then(function (res) {
			const text = `<b>ID:</b> ${msg.from.id}\n<b>Группа:</b> ${res.id}\n<b>Последнее обновление:</b> ${res.date}`;
			bot.sendMessage(msg.chat.id, text, {parse_mode: 'HTML'});
		})

		.catch(function (error) {
			console.warn(error.message);
			bot.sendMessage(msg.chat.id, `Что-то пошло не так!\n<code>${error.message}</code>`, {parse_mode: 'HTML'});
		});
});

bot.on('inline_query', function (query) {
	// Получаем нужную группу, исходя из ID
	r.table('groups')
		.get(
			r.table('users').get(query.from.id)('group')
		)('schedule')

		.then(function (schedule) {
			const now = new Date();

			// Набиваем "ответ" всеми днями недели.
			const answer = [];

			if (now.getDay() !== 0)
				answer.push({
					id: '0',
					type: 'article',
					title: 'Сегодня',
					message_text: getDay(schedule, now.getDay()),
					parse_mode: 'HTML'
				});

			if ((now.getDay() + 1) !== 0)
				answer.push({
					id: '1',
					type: 'article',
					title: 'Завтра',
					message_text: getDay(schedule, now.getDay() + 1),
					parse_mode: 'HTML'
				});

			for (let i in schedule) {
				if (i > 0)
					answer.push({
						id: i + 1,
						type: 'article',
						title: schedule[i][0],
						message_text: getDay(schedule, i),
						parse_mode: 'HTML'
					});
			}

			return bot.answerInlineQuery(query.id, answer, {is_personal: true});
		})

		.then(function (res) {
			console.log(res);
		})

		.catch(function (error) {
			// Если юзера нет в базе, то просим сохранить группу.
			console.warn(error.message);
			bot.answerInlineQuery(query.id, [], {
				switch_pm_text: 'Ты не сохранил номер группы!',
				switch_pm_parameter: 'inline',
				is_personal: true
			});
		});
});

bot.on('message', function (msg) {
	console.log(msg);
});