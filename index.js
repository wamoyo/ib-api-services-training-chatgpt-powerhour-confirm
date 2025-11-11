
/*
 * Route: api.innovationbound.com/services/training/chatgpt/power-hour/book
 * Books AI Power Hour appointment via Google Calendar OAuth
 * Creates calendar event, stores booking in DynamoDB, sends confirmation email with .ics invite
 */

import { readFile } from 'fs/promises'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { google } from 'googleapis'

var ses = new SESClient({ region: 'us-east-1' })
var dynamoDb = new DynamoDBClient({ region: 'us-east-1' })
var db = DynamoDBDocumentClient.from(dynamoDb)
var fromAddress = "Innovation Bound <website@innovationbound.com>"
var replyToAddress = "Costa Michailidis <costa@innovationbound.com>"

export async function handler (event) {
  console.log('EVENT:', JSON.stringify(event))
  if (event.httpMethod === 'OPTIONS') return respond(204) // For OPTIONS preflight

  try {
    // Event is already parsed JSON from API Gateway
    var json = event.body ? JSON.parse(event.body) : event
    var booking = json.booking || json

    var selectedTimeSlot = booking.selectedTimeSlot ?? null
    var name = booking.name ?? null
    var email = booking.email?.toLowerCase() ?? null
    var website = booking.website ?? null
    var techLevel = booking.techLevel ?? null
    var specialRequests = booking.specialRequests ?? null
    var mobile = booking.mobile ?? null

    // Check for spam (mobile field should be empty)
    if (mobile && mobile.trim() !== '') {
      console.log(`Spam detected from ${email || 'unknown'} - mobile field filled.`)
      return respond(200, {message: 'Thank you for booking!'})
    }

    // Validate incoming data
    console.log(`Validating booking info for ${email || '(no email provided)'}.`)

    if (!selectedTimeSlot) return respond(400, {error: 'Please select a time slot.'})
    if (!name) return respond(400, {error: 'Name is required.'})
    if (!email) return respond(400, {error: 'Email is required.'})
    if (email.match(/@/) == null) return respond(400, {error: 'Please provide a valid email.'})
    if (!website) return respond(400, {error: 'Company Website is required.'})
    if (techLevel && !['beginner', 'intermediate', 'advanced'].includes(techLevel)) return respond(400, {error: 'Tech level must be beginner, intermediate, or advanced.'})
    if (name.length > 2000) return respond(400, {error: 'Name must be 2000 characters or less.'})
    if (email.length > 2000) return respond(400, {error: 'Email must be 2000 characters or less.'})
    if (website.length > 2000) return respond(400, {error: 'Company Website must be 2000 characters or less.'})
    if (specialRequests && specialRequests.length > 2000) return respond(400, {error: 'Special requests must be 2000 characters or less.'})

    // Validate time slot is valid ISO timestamp
    var slotStart = new Date(selectedTimeSlot)
    if (isNaN(slotStart.getTime())) return respond(400, {error: 'Invalid time slot format.'})

    var slotEnd = new Date(slotStart.getTime() + (60 * 60 * 1000)) // 1 hour later

    // Check if this person already booked this time slot
    var bookingKey = `${selectedTimeSlot}#${email}`
    var existingBooking = await db.send(new GetCommand({
      TableName: "www.innovationbound.com",
      Key: { pk: `booking#ai-power-hour`, sk: bookingKey }
    }))

    if (existingBooking.Item) {
      return respond(400, {error: 'You have already booked this time slot.'})
    }

    // Get OAuth credentials from environment variables
    var refreshToken = process.env.GOOGLE_CAL_OAUTH_REFRESH_TOKEN
    var clientId = process.env.GOOGLE_CAL_OAUTH_CLIENT_ID
    var clientSecret = process.env.GOOGLE_CAL_OAUTH_CLIENT_SECRET

    if (!refreshToken || !clientId || !clientSecret) {
      throw new Error('Missing OAuth environment variables')
    }

    // Create OAuth2 client
    var oauth2Client = new google.auth.OAuth2(clientId, clientSecret)
    oauth2Client.setCredentials({ refresh_token: refreshToken })

    var calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    // Create Google Calendar event
    console.log(`Creating calendar event for ${email} at ${selectedTimeSlot}`)

    var calendarEvent = {
      summary: `AI Power Hour for ${name} with Innovation Bound`,
      description: `Think On 3 Questions Before Your Workshop:\n\n1. What are the top 1-3 constraints to business growth for your company?\n2. What work takes up the largest amount of your time?\n3. What questions or complaints do you have about ChatGPT and other AI tools?\n\n---\n\nBusiness Owner AI Power Hour Training & Strategy Workshop\n\nAttendee: ${name}\nEmail: ${email}\nWebsite: ${website}\nTech Level: ${techLevel || 'Not specified'}\n\nSpecial Requests:\n${specialRequests || 'None'}`,
      start: {
        dateTime: slotStart.toISOString(),
        timeZone: 'America/New_York'
      },
      end: {
        dateTime: slotEnd.toISOString(),
        timeZone: 'America/New_York'
      },
      attendees: [
        { email: email, displayName: name },
        { email: 'costa@innovationbound.com', displayName: 'Costa Michailidis', responseStatus: 'accepted' }
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 60 }       // 1 hour before
        ]
      },
      conferenceData: {
        createRequest: {
          requestId: `ai-power-hour-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }

    var createdEvent = await calendar.events.insert({
      calendarId: 'costa@innovationbound.com',
      resource: calendarEvent,
      conferenceDataVersion: 1,
      sendUpdates: 'all' // Send Google Calendar invite to attendee
    })

    console.log('Calendar event created:', createdEvent.data.id)

    var meetingLink = createdEvent.data.hangoutLink || createdEvent.data.htmlLink

    // Store booking in DynamoDB
    var bookingItem = {
      pk: `booking#ai-power-hour`,
      sk: bookingKey,  // timestamp#email format
      name: name,
      email: email,
      website: website,
      techLevel: techLevel || '',
      specialRequests: specialRequests || '',
      bookingTime: slotStart.toISOString(),
      durationMinutes: 60,
      googleEventId: createdEvent.data.id,
      meetingLink: meetingLink,
      bookedAt: new Date().toISOString()
    }

    await db.send(new PutCommand({
      TableName: "www.innovationbound.com",
      Item: bookingItem
    }))

    console.log('Booking stored in DynamoDB')

    // Send confirmation email with calendar invite
    console.log(`Sending confirmation email to ${email}`)

    var rawHtml = await readFile("booking-confirmation.html", "utf8")
    var rawTxt = await readFile("booking-confirmation.txt", "utf8")

    // Format date/time for email
    var dateTimeDisplay = slotStart.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: 'America/New_York'
    })

    // Replace template variables
    var html = rawHtml
      .replace(/{{tracking}}/g, `email=${email}&list=ai-power-hour-bookings&edition=booking-confirmation`)
      .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)
      .replace(/{{name}}/g, name)
      .replace(/{{email}}/g, email)
      .replace(/{{dateTime}}/g, dateTimeDisplay)
      .replace(/{{meetingLink}}/g, meetingLink)
      .replace(/{{website}}/g, website)
      .replace(/{{techLevel}}/g, techLevel || 'Not specified')
      .replace(/{{specialRequests}}/g, specialRequests || 'None')

    var txt = rawTxt
      .replace(/{{tracking}}/g, `email=${email}&list=ai-power-hour-bookings&edition=booking-confirmation`)
      .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)
      .replace(/{{name}}/g, name)
      .replace(/{{email}}/g, email)
      .replace(/{{dateTime}}/g, dateTimeDisplay)
      .replace(/{{meetingLink}}/g, meetingLink)
      .replace(/{{website}}/g, website)
      .replace(/{{techLevel}}/g, techLevel || 'Not specified')
      .replace(/{{specialRequests}}/g, specialRequests || 'None')

    // Create .ics calendar file attachment
    // COMMENTED OUT: Testing Google Calendar invite approach without .ics attachment
    // var icsContent = createICS({
    //   summary: `AI Power Hour for ${name} with Innovation Bound`,
    //   description: `Think On 3 Questions Before Your Workshop:\\n\\n1. What are the top 1-3 constraints to business growth for your company?\\n2. What work takes up the largest amount of your time?\\n3. What questions or complaints do you have about ChatGPT and other AI tools?\\n\\n---\\n\\nBusiness Owner AI Power Hour Training & Strategy Workshop\\n\\nAttendee: ${name}\\nEmail: ${email}\\nWebsite: ${website}\\nTech Level: ${techLevel || 'Not specified'}\\n\\nSpecial Requests:\\n${specialRequests || 'None'}\\n\\nJoin via Google Meet: ${meetingLink}`,
    //   location: meetingLink,
    //   start: slotStart,
    //   end: slotEnd,
    //   organizerEmail: 'costa@innovationbound.com',
    //   organizerName: 'Costa Michailidis',
    //   attendeeEmail: email,
    //   attendeeName: name
    // })

    // Send email using SendRawEmailCommand (no .ics attachment)
    var boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(7)}`

    var rawMessage = [
      `From: ${fromAddress}`,
      `To: ${email}`,
      `Bcc: ${replyToAddress}`,
      `Reply-To: ${replyToAddress}`,
      `Subject: 🦾 AI Power Hour Confirmed - ${dateTimeDisplay}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      txt,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html,
      ``,
      `--${boundary}--`
    ].join('\r\n')

    // COMMENTED OUT: Old approach with .ics attachment
    // var rawMessage = [
    //   `From: ${replyToAddress}`,
    //   `To: ${email}`,
    //   `Bcc: ${replyToAddress}`,
    //   `Reply-To: ${replyToAddress}`,
    //   `Subject: 🦾 AI Power Hour Confirmed - ${dateTimeDisplay}`,
    //   `MIME-Version: 1.0`,
    //   `Content-Type: multipart/mixed; boundary="${boundary}"`,
    //   ``,
    //   `--${boundary}`,
    //   `Content-Type: multipart/alternative; boundary="${boundary}_alt"`,
    //   ``,
    //   `--${boundary}_alt`,
    //   `Content-Type: text/plain; charset=UTF-8`,
    //   ``,
    //   txt,
    //   ``,
    //   `--${boundary}_alt`,
    //   `Content-Type: text/html; charset=UTF-8`,
    //   ``,
    //   html,
    //   ``,
    //   `--${boundary}_alt--`,
    //   ``,
    //   `--${boundary}`,
    //   `Content-Type: text/calendar; charset=UTF-8; method=REQUEST`,
    //   `Content-Disposition: attachment; filename="ai-power-hour.ics"`,
    //   ``,
    //   icsContent,
    //   ``,
    //   `--${boundary}--`
    // ].join('\r\n')

    await ses.send(new SendRawEmailCommand({
      RawMessage: {
        Data: new TextEncoder().encode(rawMessage)
      }
    }))

    console.log('Confirmation email sent')

    // Respond
    return respond(200, {message: `AI Power Hour booked for ${name} at ${dateTimeDisplay}`})

  } catch (error) {
    console.error('Booking error:', error)
    return respond(500, {error: 'Something went wrong. Please try again or contact costa@innovationbound.com'})
  }
}

// Pure: Creates .ics calendar file content
function createICS (event) {
  var now = new Date()
  var timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'

  var startStr = event.start.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  var endStr = event.end.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Innovation Bound//AI Power Hour//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:ai-power-hour-${timestamp}@innovationbound.com`,
    `DTSTAMP:${timestamp}`,
    `DTSTART:${startStr}`,
    `DTEND:${endStr}`,
    `SUMMARY:${event.summary}`,
    `DESCRIPTION:${event.description}`,
    `LOCATION:${event.location}`,
    `ORGANIZER;CN=${event.organizerName}:mailto:${event.organizerEmail}`,
    `ATTENDEE;CN=${event.attendeeName};PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${event.attendeeEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    'DESCRIPTION:AI Power Hour starts in 1 hour',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
}

function respond (code, message) {
  return {
    body: code === 204 ? '' : JSON.stringify(message),
    headers: {
      'Content-Type': 'application/json',
      // 'Access-Control-Allow-Origin' : 'https://www.innovationbound.com',
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Methods' : 'POST,OPTIONS',
      'Access-Control-Allow-Headers' : 'Accept, Content-Type, Authorization',
      // 'Access-Control-Allow-Credentials' : true
    },
    isBase64Encoded: false,
    statusCode: code
  }
}
