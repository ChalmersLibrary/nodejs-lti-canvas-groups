function downloadCsv(categoryId, categoryName) {
    window.location.href = "/csv/category/" + categoryId + "/" + categoryName.replace("/", "-").replace(" ", "%20");
}

function downloadCsvZoom(categoryId, categoryName) {
    window.location.href = "/csv/zoom/category/" + categoryId + "/" + categoryName.replace("/", "-").replace(" ", "%20");
}

function renderDashboard() {
    if ($('#chartContainer')) {
        let data_labels = [];
        var data_reads = [];
        var data_reads_total = 0;
        var data_writes = [];
        var data_writes_total = 0;

        $.getJSON('/json/stats').done(function(data) {
            $.each(data.cache_stats, function(index, value) {
                data_labels.push(value.name);
                data_reads.push(value.reads);
                data_writes.push(value.writes);
                data_reads_total = data_reads_total + value.reads;
                data_writes_total = data_writes_total + value.writes;
            });

            $('#active_users').text(data.active_users_today);
            $('#total_users').text(data.authorized_users);
            $('#total_reads').text(data_reads_total);
            $('#total_writes').text(data_writes_total);

            (data_reads_total > 0 && data_writes_total > 0) ? $('span.percent').text(' (' + Math.round((data_reads_total / data_writes_total) * 100) + '%)'): $('span.percent').text(' (0%)');

            var ctx = document.getElementById('chartContainer').getContext('2d');

            var myChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data_labels,
                    datasets: [{
                            label: 'Cache writes',
                            data: data_writes,
                            backgroundColor: 'rgba(32, 161, 112, 1)',
                            borderWidth: 0
                        },
                        {
                            label: 'Cache reads',
                            data: data_reads,
                            backgroundColor: 'rgba(144, 144, 88, 1)',
                            borderWidth: 0
                        }
                    ]
                },
                options: {
                    scales: {
                        yAxes: [{
                            ticks: {
                                beginAtZero: true
                            }
                        }]
                    }
                }
            });
        });
    }
}

document.addEventListener('DOMContentLoaded', function () {
    if (document.location.pathname.startsWith("/loading")) {
        setInterval(function () {
            var progress = document.getElementsByTagName('progress')[0];
            if (progress.value < progress.max) {
                progress.value > 30 && progress.value < 60 ? progress.value += 3 : progress.value += 1;
            }
        }, 900);
    }
    else if (document.location.pathname.startsWith("/groups")) {
        const btnCsv = document.getElementsByClassName("btn-download-csv");
        const btnCsvZoom = document.getElementsByClassName("btn-download-csv-zoom");
        Array.from(btnCsv).forEach(element => {
            element.addEventListener("click", function () {
                downloadCsv(element.getAttribute("data-category-id"), element.getAttribute("data-category-name"));
            }); 
        });
        Array.from(btnCsvZoom).forEach(element => {
            element.addEventListener("click", function () {
                downloadCsvZoom(element.getAttribute("data-category-id"), element.getAttribute("data-category-name"));
            });
        });

        const selfSignupConfigModal = document.getElementById('selfSignupConfigurationModal');
        selfSignupConfigModal && selfSignupConfigModal.addEventListener("show.bs.modal", event => {
            console.log(event);
            selfSignupConfigModal.querySelector("#css_group_category_name").innerText = event.relatedTarget.dataset.categoryName;
            fetch(`/api/config/self-signup/${event.relatedTarget.dataset.categoryId}/${event.relatedTarget.dataset.categoryName}`)
                .then(response => response.json())
                .then(data => {
                    console.log(data);
                    selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";

                    selfSignupConfigModal.querySelector("#css_assignment_id").replaceChildren();
                    if (data.assignments && data.assignments.length) {
                        data.assignments.forEach(assignment => {
                            let o = selfSignupConfigModal.querySelector("#css_assignment_id").appendChild(document.createElement("option"));
                            o.value = assignment.id;
                            o.innerText = `${assignment.name} (${assignment.points_possible} points)`;
                            data.current && data.current.assignment_id && o.value == data.current.assignment_id && o.setAttribute("selected", true);
                        })
                    }
                    if (data.assignments && !data.assignments.length) {
                        let o = selfSignupConfigModal.querySelector("#css_assignment_id").appendChild(document.createElement("option"));
                        o.innerText = "No valid assignments found in course";
                        data.current && data.current.assignment_id && o.value == data.current.assignment_id && o.setAttribute("selected", true);
                        selfSignupConfigModal.querySelector("#modalSubmitButton").setAttribute("disabled", true);
                    }
                    if (data.current && data.current.description) {
                        selfSignupConfigModal.querySelector("#css_description").value = data.current.description;
                    }
                    if (data.current && data.current.min_points) {
                        selfSignupConfigModal.querySelector("#css_min_points").value = data.current.min_points;
                    }
                    if (data.current && selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display == "none") {
                        selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display = "inline";
                    }
                    // no data.current... clear values etc...
                    selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").setAttribute("action", `/api/config/self-signup/${event.relatedTarget.dataset.categoryId}`);
                    selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").addEventListener("submit", event => {
                        const submitButton = selfSignupConfigModal.querySelector("#modalSubmitButton");
                        const submitButtonSpinner = selfSignupConfigModal.querySelector("#modalSubmitButtonSpinner");
                        submitButton.disabled = true;
                        submitButtonSpinner.style.display = "inline-block";

                        selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                        selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";

                        const requestOptions = {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                assignment_id: selfSignupConfigModal.querySelector("#css_assignment_id").value,
                                description: selfSignupConfigModal.querySelector("#css_description").value,
                                min_points: selfSignupConfigModal.querySelector("#css_min_points").value
                            })
                        };
                        console.log(requestOptions);
                        fetch(selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").getAttribute('action'), requestOptions)
                            .then(response => response.json())
                            .then(data => {
                                console.log(data);
                                submitButton.disabled = false;
                                submitButtonSpinner.style.display = "none";
                                if (!data.success) {
                                    selfSignupConfigModal.querySelector("#errorInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                                }
                                else {
                                    selfSignupConfigModal.querySelector("#successInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";
                                    selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display = "inline";
                                }
                            });
                        
                        event.preventDefault();
                        event.stopPropagation();
                    });
                    selfSignupConfigModal.querySelector("#selfSignupConfigurationForm button#modalClearRuleButton").addEventListener("click", event => {
                        console.log("Clear rule.");

                        const button = selfSignupConfigModal.querySelector("#modalClearRuleButton");
                        const buttonSpinner = selfSignupConfigModal.querySelector("#modalClearRuleButtonSpinner");
                        button.disabled = true;
                        buttonSpinner.style.display = "inline-block";

                        selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                        selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";

                        const requestOptions = {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' }
                        };

                        console.log(requestOptions);

                        fetch(selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").getAttribute('action'), requestOptions)
                            .then(response => response.json())
                            .then(data => {
                                console.log(data);

                                button.disabled = false;
                                buttonSpinner.style.display = "none";

                                if (!data.success) {
                                    selfSignupConfigModal.querySelector("#errorInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                                }
                                else {
                                    selfSignupConfigModal.querySelector("#successInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";
                                    selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display = "none";    
                                }
                            });
                        
                        event.preventDefault();
                        event.stopPropagation();
                    });
                });
        });
    }
    else if (document.location.pathname.startsWith("/dashboard")) {
        renderDashboard();
        setInterval(renderDashboard, 600000); // Every 10 mins
    }
});