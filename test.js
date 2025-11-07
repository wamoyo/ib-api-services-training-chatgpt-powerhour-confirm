
/*
 * Testing our booking lambda function
 */

import { handler } from './index.js'

// Test booking - select a time slot from the future
var tomorrow = new Date()
tomorrow.setDate(tomorrow.getDate() + 1)
tomorrow.setHours(14, 0, 0, 0) // 2pm tomorrow

var booking = {
  "selectedTimeSlot": tomorrow.toISOString(),
  "name": "Costa Michailidis",
  "email": "costa@trollhair.com",
  "website": "https://www.innovationbound.com",
  "techLevel": "advanced",
  "specialRequests": "Looking forward to learning about AI automation for my consulting business!"
}

console.log('Testing booking Lambda...')
console.log('Booking slot:', booking.selectedTimeSlot)
console.log('')

// The curly braces below create an object, remember ; )
handler({ body: JSON.stringify({ booking }) })
  .then(function (result) {
    console.log('\n=== LAMBDA RESPONSE ===')
    console.log('Status Code:', result.statusCode)
    console.log('\n=== RESPONSE BODY ===')
    var body = JSON.parse(result.body)
    console.log(JSON.stringify(body, null, 2))
  })
  .catch(function (error) {
    console.error('\n=== ERROR ===')
    console.error(error)
  })
